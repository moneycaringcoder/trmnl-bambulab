/**
 * The bridge, running.
 *
 * Everything below this module is pure or narrowly scoped; this is where the
 * I/O and the clock live. It does four things at once:
 *
 *   - polls Bambu Cloud over HTTP on the push cadence, for identity, online
 *     state, job and progress;
 *   - holds one subscribe-only MQTT session, for the layer counts, remaining
 *     time and temperatures that HTTP does not carry;
 *   - merges both into one view per printer;
 *   - and pushes a bounded snapshot to the user's TRMNL webhook when the
 *     scheduler says it may.
 *
 * The two read paths fail independently and neither is required. Losing MQTT
 * costs the temperatures and the layer counter; losing HTTP costs the printer
 * names. Losing both is reported rather than retried into the ground.
 *
 * Nothing here sends anything to a printer. The MQTT client has no encoder for
 * it, which is the point of `docs/DECISIONS.md` D2.
 */

import {
  accept,
  emptyCoordinatorState,
  snapshotsFor,
  type CoordinatorState,
} from "../coordinator/merge.ts";
import { openTlsStream } from "../mqtt/transport-node.ts";
import { CLOUD_MQTT_PORT, hostsFor } from "../providers/bambu-cloud/hosts.ts";
import { preference } from "../providers/bambu-cloud/api.ts";
import { mqttUsernameForUid, mqttUsernameFromToken } from "../providers/bambu-cloud/token.ts";
import { healthFrom, pollCloudHttp } from "../providers/cloud-http.ts";
import { watchCloudMqtt } from "../providers/cloud-mqtt.ts";
import { buildWebhookPayload } from "../push/payload.ts";
import {
  decide,
  emptySchedulerState,
  recordPush,
  type SchedulerState,
} from "../push/scheduler.ts";
import type { BridgeConfig } from "../setup/config.ts";
import { maskIdentifier } from "../setup/mask.ts";
import { pushPayload } from "../setup/webhook-push.ts";
import type { Observation, ProviderStatus } from "../types.ts";
import { isRetryable, retryDelayMs } from "./backoff.ts";
import { createLogger, type Logger } from "./log.ts";

/**
 * One cycle per five minutes, which is TRMNL's twelve-per-hour ceiling. There
 * is nothing to gain from polling faster than the only output can change.
 */
export const CYCLE_MS = 5 * 60_000;

/** Distinguishes this installation from any other client on the account. */
function clientId(): string {
  return `trmnl-bambulab-${Math.random().toString(36).slice(2, 10)}`;
}

export interface RunOptions {
  config: BridgeConfig;
  logger?: Logger;
  /** Resolves when the bridge should shut down. */
  until?: Promise<void>;
}

/**
 * Resolves the MQTT username.
 *
 * A JWT-shaped token volunteers it. An opaque one does not, and then the
 * account id comes from the cheapest read-only endpoint there is. A failure
 * here costs the MQTT path and nothing else, so it is reported rather than
 * fatal: HTTP alone is still a working display.
 */
async function resolveMqttUsername(
  config: BridgeConfig,
  logger: Logger,
): Promise<string | null> {
  const fromToken = mqttUsernameFromToken(config.cloud.accessToken);
  if (fromToken !== null) return fromToken;

  try {
    const { uid } = await preference(hostsFor(config.cloud.region), config.cloud.accessToken);
    return mqttUsernameForUid(uid);
  } catch {
    logger.warn(
      "could not read the account id, so live telemetry is unavailable this run",
      { effect: "no layer counts, remaining time, or temperatures" },
    );
    return null;
  }
}

export async function runBridge(options: RunOptions): Promise<void> {
  const { config } = options;
  const logger = options.logger ?? createLogger(config.logLevel);
  const hosts = hostsFor(config.cloud.region);

  if (config.trmnl.webhookUrl === null) {
    logger.error("no TRMNL webhook URL is configured, so there is nowhere to push", {
      fix: "run `pnpm setup webhook`",
    });
    return;
  }
  const webhookUrl = config.trmnl.webhookUrl;

  let coordinator: CoordinatorState = emptyCoordinatorState();
  let scheduler: SchedulerState = emptySchedulerState();
  let cloudStatus: ProviderStatus = "connecting";
  let stopped = false;

  const observe = (observation: Observation): void => {
    coordinator = accept(coordinator, observation);
  };

  logger.info("bridge starting", {
    region: config.cloud.region,
    printers: config.cloud.deviceIds.length,
    cadence_seconds: CYCLE_MS / 1000,
    export_job_name: config.trmnl.exportJobName,
  });
  for (const deviceId of config.cloud.deviceIds) {
    logger.debug("watching printer", { printer: maskIdentifier(deviceId) });
  }

  const username = await resolveMqttUsername(config, logger);

  // Both loops run for the process's lifetime and neither awaits the other. A
  // dead MQTT session must not stall a poll, and a refused poll must not tear
  // down a healthy subscription.
  const telemetry =
    username === null
      ? Promise.resolve()
      : runTelemetryLoop({
          config,
          username,
          logger,
          observe,
          shouldStop: () => stopped,
        });

  const pushing = (async () => {
    for (;;) {
      const now = Date.now();

      const poll = await pollCloudHttp({
        hosts,
        accessToken: config.cloud.accessToken,
        deviceIds: config.cloud.deviceIds,
        exportJobName: config.trmnl.exportJobName,
        now,
      });
      for (const observation of poll.observations) observe(observation);
      cloudStatus = poll.status;

      const health = healthFrom(poll, now);
      if (poll.status === "reauth_required") {
        logger.error("Bambu Cloud refused the stored token", {
          fix: "run `pnpm setup reauth` to sign in again",
        });
      } else if (health.lastErrorCategory !== null) {
        logger.warn("a cloud read failed", { category: health.lastErrorCategory });
      }

      const snapshots = snapshotsFor(coordinator, config.cloud.deviceIds, now);
      const payload = buildWebhookPayload(snapshots, {
        now,
        cloud: cloudStatus,
        maxBytes: config.trmnl.maxPayloadBytes,
        exportJobName: config.trmnl.exportJobName,
      });
      if (payload.shed.length > 0) {
        logger.debug("shed optional detail to fit the payload ceiling", {
          given_up: payload.shed.join(","),
          bytes: payload.bytes,
        });
      }

      const decision = decide(scheduler, payload, {
        now,
        maxPushesPerHour: config.trmnl.maxPushesPerHour,
        maxPayloadBytes: config.trmnl.maxPayloadBytes,
      });

      if (decision.kind === "push") {
        const result = await pushPayload(webhookUrl, payload.body);
        if (result.ok) {
          scheduler = recordPush(scheduler, now, payload.serialized);
          logger.info("pushed to TRMNL", {
            reason: decision.reason,
            bytes: payload.bytes,
            printers: payload.variables.printers.length,
            status: result.status,
          });
        } else {
          // Not recorded: a refused push spent no budget, and pretending it did
          // would suppress the retry that a transient failure deserves.
          logger.warn("TRMNL refused the push", {
            kind: result.kind,
            status: result.status,
            guidance: result.guidance,
          });
        }
      } else {
        logger.debug("no push this cycle", {
          reason: decision.reason,
          retry_after_ms: decision.reason === "rate-limited" ? decision.retryAfterMs : null,
        });
      }

      if (await sleepOrStop(CYCLE_MS, options.until)) break;
    }
    stopped = true;
  })();

  await Promise.all([pushing, telemetry]);
  logger.info("bridge stopped");
}

interface TelemetryLoopOptions {
  config: BridgeConfig;
  username: string;
  logger: Logger;
  observe: (observation: Observation) => void;
  shouldStop: () => boolean;
}

/**
 * One MQTT session at a time, reconnected with bounded jittered backoff.
 *
 * One session, never several: the concurrent-connection count is what Bambu
 * has objected to. A rejection that cannot succeed on retry — a refused token,
 * a refused subscription — stops the loop rather than spinning against it.
 */
async function runTelemetryLoop(options: TelemetryLoopOptions): Promise<void> {
  const { config, username, logger, observe, shouldStop } = options;
  const hosts = hostsFor(config.cloud.region);
  let failures = 0;

  while (!shouldStop()) {
    try {
      const stream = await openTlsStream({ host: hosts.mqtt, port: CLOUD_MQTT_PORT });
      const { end } = watchCloudMqtt(stream, {
        username,
        accessToken: config.cloud.accessToken,
        deviceIds: config.cloud.deviceIds,
        exportJobName: config.trmnl.exportJobName,
        clientId: clientId(),
        clock: () => Date.now(),
        onObservation: observe,
        onSubscribed: () => {
          failures = 0;
          logger.info("live telemetry subscribed", {
            printers: config.cloud.deviceIds.length,
          });
        },
      });

      const ending = await end;
      if (!isRetryable(ending.reason)) {
        logger.error("the cloud broker refused this session and retrying cannot help", {
          reason: ending.reason,
          detail: "detail" in ending ? ending.detail : null,
          fix: "run `pnpm setup reauth` if the token has expired",
        });
        return;
      }
      logger.warn("live telemetry session ended", { reason: ending.reason });
    } catch (cause) {
      logger.warn("could not reach the cloud broker", {
        detail: cause instanceof Error ? cause.message : "an unknown error",
      });
    }

    failures += 1;
    const delay = retryDelayMs(failures);
    logger.debug("waiting before reconnecting", { attempt: failures, delay_ms: delay });
    if (await sleepOrStop(delay)) return;
  }
}

/** Resolves true when the bridge should stop rather than continue. */
function sleepOrStop(ms: number, until?: Promise<void>): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(false), ms);
  void until?.then(() => {
    clearTimeout(timer);
    resolve(true);
  });
  return promise;
}

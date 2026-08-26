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
 * it.
 */

import {
  accept,
  emptyCoordinatorState,
  snapshotsFor,
  type CoordinatorState,
} from "@trmnl-bambulab/core/telemetry/coordinator/merge";
import { openTlsStream } from "@trmnl-bambulab/core/telemetry/mqtt/transport-node";
import { CLOUD_MQTT_PORT, hostsFor } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/hosts";
import { preference } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/api";
import {
  mqttUsernameForUid,
  mqttUsernameFromToken,
} from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/token";
import { healthFrom, pollCloudHttp } from "@trmnl-bambulab/core/telemetry/providers/cloud-http";
import { watchCloudMqtt } from "@trmnl-bambulab/core/telemetry/providers/cloud-mqtt";
import { buildWebhookPayload } from "@trmnl-bambulab/core/telemetry/push/payload";
import {
  decide,
  emptySchedulerState,
  recordPush,
  type SchedulerState,
} from "../push/scheduler.ts";
import type { BridgeConfig } from "../setup/config.ts";
import { maskIdentifier } from "../setup/mask.ts";
import { pushPayload } from "../setup/webhook-push.ts";
import type { Observation, ProviderStatus } from "@trmnl-bambulab/core/telemetry/types";
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

export interface RunDependencies {
  pollCloud: typeof pollCloudHttp;
  push: typeof pushPayload;
  openMqttStream: typeof openTlsStream;
  watchMqtt: typeof watchCloudMqtt;
  now(): number;
}

const SYSTEM_DEPENDENCIES: RunDependencies = {
  pollCloud: pollCloudHttp,
  push: pushPayload,
  openMqttStream: openTlsStream,
  watchMqtt: watchCloudMqtt,
  now: Date.now,
};

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

export async function runBridge(
  options: RunOptions,
  dependencies: RunDependencies = SYSTEM_DEPENDENCIES,
): Promise<void> {
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
  const stopping = new AbortController();
  void options.until?.then(() => stopping.abort());

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
          stopping: stopping.signal,
          dependencies,
        });

  const pushing = (async () => {
    try {
      while (!stopping.signal.aborted) {
        const now = dependencies.now();

        const poll = await dependencies.pollCloud({
          hosts,
          accessToken: config.cloud.accessToken,
          deviceIds: config.cloud.deviceIds,
          exportJobName: config.trmnl.exportJobName,
          now,
        });
        if (stopping.signal.aborted) break;
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
          const result = await dependencies.push(webhookUrl, payload.body);
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
            retry_after_ms:
              decision.reason === "rate-limited" ? decision.retryAfterMs : null,
          });
        }

        if (await sleepOrStop(CYCLE_MS, stopping.signal)) break;
      }
    } finally {
      // A failed push loop must not strand the MQTT socket either.
      stopping.abort();
    }
  })();

  await Promise.all([pushing, telemetry]);
  logger.info("bridge stopped");
}

interface TelemetryLoopOptions {
  config: BridgeConfig;
  username: string;
  logger: Logger;
  observe: (observation: Observation) => void;
  stopping: AbortSignal;
  dependencies: RunDependencies;
}

/**
 * One MQTT session at a time, reconnected with bounded jittered backoff.
 *
 * One session, never several: the concurrent-connection count is what Bambu
 * has objected to. A rejection that cannot succeed on retry — a refused token,
 * a refused subscription — stops the loop rather than spinning against it.
 */
async function runTelemetryLoop(options: TelemetryLoopOptions): Promise<void> {
  const { config, username, logger, observe, stopping, dependencies } = options;
  const hosts = hostsFor(config.cloud.region);
  let failures = 0;

  while (!stopping.aborted) {
    try {
      const stream = await dependencies.openMqttStream({
        host: hosts.mqtt,
        port: CLOUD_MQTT_PORT,
      });
      if (stopping.aborted) {
        await stream.close().catch(() => undefined);
        return;
      }

      const { end, stop } = dependencies.watchMqtt(stream, {
        username,
        accessToken: config.cloud.accessToken,
        deviceIds: config.cloud.deviceIds,
        exportJobName: config.trmnl.exportJobName,
        clientId: clientId(),
        clock: dependencies.now,
        onObservation: observe,
        onSubscribed: () => {
          failures = 0;
          logger.info("live telemetry subscribed", {
            printers: config.cloud.deviceIds.length,
          });
        },
      });
      const stopOnShutdown = (): void => {
        void stop();
      };
      stopping.addEventListener("abort", stopOnShutdown, { once: true });
      const ending = await end.finally(() => {
        stopping.removeEventListener("abort", stopOnShutdown);
      });
      if (stopping.aborted) return;
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
      if (stopping.aborted) return;
      logger.warn("could not reach the cloud broker", {
        detail: cause instanceof Error ? cause.message : "an unknown error",
      });
    }

    failures += 1;
    const delay = retryDelayMs(failures);
    logger.debug("waiting before reconnecting", { attempt: failures, delay_ms: delay });
    if (await sleepOrStop(delay, stopping)) return;
  }
}

/** Resolves true when the bridge should stop rather than continue. */
function sleepOrStop(ms: number, stopping?: AbortSignal): Promise<boolean> {
  if (stopping?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const stop = (): void => {
      clearTimeout(timer);
      stopping?.removeEventListener("abort", stop);
      resolve(true);
    };
    const timer = setTimeout(() => {
      stopping?.removeEventListener("abort", stop);
      resolve(false);
    }, ms);
    stopping?.addEventListener("abort", stop, { once: true });
  });
}

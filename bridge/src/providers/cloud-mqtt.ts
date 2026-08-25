/**
 * The Bambu Cloud MQTT read path, as a provider.
 *
 * Subscribes to the report topic of each chosen printer and turns every report
 * into an observation. This is where layer counts, remaining time and
 * temperatures come from; no HTTP endpoint carries them.
 *
 * It subscribes and never publishes. On an X1-class printer that is enough,
 * because every report is a complete status object. On a P1 it means the
 * bridge learns a field only when the printer next changes it: the documented
 * way to demand a full baseline is to publish a `pushall` request to the
 * printer, and this project does not send messages to printers. During an
 * actual print the fields we care about change every few seconds, so the gap
 * closes almost immediately, and while idle there is nothing to know that HTTP
 * has not already said.
 *
 * Reconnection is the caller's decision, not this module's. Bambu has
 * temporarily banned accounts over reconnect storms, so backoff belongs where
 * the whole picture is visible.
 */

import { MqttSession, type ByteStream, type SessionEnd } from "../mqtt/client.ts";
import { CLOUD_MQTT_CAPABILITIES, parseReport } from "../normalize/cloud-mqtt.ts";
import type { Observation } from "../types.ts";

/** `device/<id>/report`. The request topic is never constructed anywhere. */
export function reportTopic(deviceId: string): string {
  return `device/${deviceId}/report`;
}

/**
 * Recovers the device id from a report topic.
 *
 * Returns null for a topic that does not match, rather than guessing. A report
 * we cannot attribute to a printer is worse than no report: attributing it to
 * the wrong one would show one printer's job on another's card.
 */
export function deviceIdFromTopic(topic: string): string | null {
  const parts = topic.split("/");
  if (parts.length !== 3 || parts[0] !== "device" || parts[2] !== "report") return null;
  const deviceId = parts[1];
  return deviceId !== undefined && deviceId.length > 0 ? deviceId : null;
}

export interface WatchOptions {
  /** The MQTT username, `u_<uid>`. */
  username: string;
  /** The Bambu access token, used as the MQTT password. Never logged. */
  accessToken: string;
  deviceIds: readonly string[];
  exportJobName: boolean;
  /** Distinguishes this installation's session from any other client's. */
  clientId: string;
  /** Bridge clock. A parameter so the provider stays testable. */
  clock: () => number;
  onObservation: (observation: Observation) => void;
  onSubscribed?: () => void;
}

/**
 * Runs one subscription session over an already-connected byte stream.
 *
 * The stream is supplied rather than opened here, so the same provider serves
 * the Node bridge and a Cloudflare Worker without a second implementation.
 * Resolves with how the session ended.
 */
export function watchCloudMqtt(
  stream: ByteStream,
  options: WatchOptions,
): { end: Promise<SessionEnd>; stop: () => Promise<void> } {
  const wanted = new Set(options.deviceIds);

  const session = new MqttSession(stream, {
    clientId: options.clientId,
    username: options.username,
    password: options.accessToken,
    topics: options.deviceIds.map(reportTopic),
    ...(options.onSubscribed === undefined ? {} : { onSubscribed: options.onSubscribed }),
    onReport: (topic, payload) => {
      const deviceId = deviceIdFromTopic(topic);
      if (deviceId === null || !wanted.has(deviceId)) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch {
        // A malformed report is dropped, not escalated. The next one is
        // seconds away and the printer is not at fault for our parser.
        return;
      }

      const fields = parseReport(parsed, { exportJobName: options.exportJobName });
      if (fields === null) return;

      options.onObservation({
        providerId: "cloud-mqtt",
        printerKey: deviceId,
        receivedAt: options.clock(),
        // Reports carry no clock we trust more than our own.
        observedAt: null,
        fields,
        capabilities: CLOUD_MQTT_CAPABILITIES,
      });
    },
  });

  return { end: session.run(), stop: () => session.stop() };
}

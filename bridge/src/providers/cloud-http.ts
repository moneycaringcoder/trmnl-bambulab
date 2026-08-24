/**
 * The Bambu Cloud HTTP read path, as a provider.
 *
 * Polls the two read-only endpoints that describe an account's printers and
 * turns each response into observations for the coordinator. This is the floor
 * of the product: on its own it gives which printers exist, whether they are
 * online, what they are printing and how far along it is. Layer counts,
 * remaining time and temperatures are not available over HTTP at all and come
 * from the MQTT path instead. See `docs/DECISIONS.md` D3.
 *
 * The poll interval is the push cadence, because there is no point learning
 * something more often than it can be shown. See D4.
 *
 * Nothing here retries. A failure is reported as health, and the caller decides
 * whether to wait, back off, or tell the user to sign in again. An expired
 * token in particular must surface as an instruction rather than as a loop.
 */

import { CloudError, request } from "./bambu-cloud/http.ts";
import type { CloudHosts } from "./bambu-cloud/hosts.ts";
import {
  CLOUD_HTTP_CAPABILITIES,
  parseBindReport,
  parseCurrentPrint,
} from "../normalize/cloud-http.ts";
import type { Observation, ProviderHealth, ProviderStatus } from "../types.ts";

const DEVICE_BIND_PATH = "/v1/iot-service/api/user/bind";
const CURRENT_PRINT_PATH = "/v1/iot-service/api/user/print?force=true";

export interface PollOptions {
  hosts: CloudHosts;
  accessToken: string;
  /** Only these printers are reported. The user chose them during setup. */
  deviceIds: readonly string[];
  exportJobName: boolean;
  /** Bridge clock at the start of the poll, epoch milliseconds. */
  now: number;
}

export interface PollResult {
  observations: Observation[];
  status: ProviderStatus;
  /** Set when the poll failed, for health reporting. Never a response body. */
  errorCategory: string | null;
}

/**
 * One poll of both endpoints.
 *
 * `/bind` is the authority on which printers exist and what they are called.
 * `/print` adds the current job and its progress. They are requested together
 * because either alone leaves an obvious gap, and a single missing response
 * should degrade the picture rather than discard it: if `/print` fails we still
 * know the printer is online, and that is worth showing.
 */
export async function pollCloudHttp(options: PollOptions): Promise<PollResult> {
  const { hosts, accessToken, deviceIds, exportJobName, now } = options;
  const wanted = new Set(deviceIds);

  const [bind, current] = await Promise.allSettled([
    request<unknown>(hosts, DEVICE_BIND_PATH, { token: accessToken }),
    request<unknown>(hosts, CURRENT_PRINT_PATH, { token: accessToken }),
  ]);

  if (bind.status === "rejected" && current.status === "rejected") {
    const category = categoryOf(bind.reason);
    return {
      observations: [],
      // An expired token is not a transport problem and must not be retried as
      // one, so it gets its own status and its own advice upstream.
      status: category === "unauthorized-or-expired" ? "reauth_required" : "disconnected",
      errorCategory: category,
    };
  }

  const observations: Observation[] = [];

  if (bind.status === "fulfilled") {
    for (const [deviceId, fields] of parseBindReport(bind.value)) {
      if (!wanted.has(deviceId)) continue;
      observations.push({
        providerId: "cloud-http",
        printerKey: deviceId,
        receivedAt: now,
        // The cloud sends no trustworthy observation time on these endpoints,
        // and inventing one would make staleness a lie.
        observedAt: null,
        fields,
        capabilities: CLOUD_HTTP_CAPABILITIES,
      });
    }
  }

  if (current.status === "fulfilled") {
    for (const [deviceId, fields] of parseCurrentPrint(current.value, { exportJobName })) {
      if (!wanted.has(deviceId)) continue;
      observations.push({
        providerId: "cloud-http",
        printerKey: deviceId,
        receivedAt: now,
        observedAt: null,
        fields,
        capabilities: CLOUD_HTTP_CAPABILITIES,
      });
    }
  }

  // Half a picture is still worth showing: if `/print` failed we still know
  // the printer is online, and that belongs on the display.
  const failed = bind.status === "rejected" ? bind : current.status === "rejected" ? current : null;
  return {
    observations,
    status: "connected",
    errorCategory: failed === null ? null : categoryOf(failed.reason),
  };
}

/** A category, never a message: a cloud error body can name the account. */
function categoryOf(reason: unknown): string {
  return reason instanceof CloudError ? reason.category : "network-error";
}

export function healthFrom(result: PollResult, at: number): ProviderHealth {
  return {
    id: "cloud-http",
    status: result.status,
    lastObservationAt: result.observations.length > 0 ? at : null,
    lastErrorCategory: result.errorCategory,
  };
}

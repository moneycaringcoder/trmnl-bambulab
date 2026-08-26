/**
 * Read-only Bambu Cloud endpoints.
 *
 * Every path here is reverse-engineered from OpenBambuAPI and ha-bambulab. None
 * of it is a supported public API contract, so responses are parsed
 * defensively and drift is expected.
 *
 * Read-only means read-only: nothing in this file mutates the account, starts a
 * print, or sends a printer command.
 */

import { z } from "zod";
import type { CloudHosts } from "./hosts.ts";
import { request } from "./http.ts";

export interface Preference {
  uid: number;
  name: string;
}

export interface CloudDevice {
  /**
   * Raw `dev_id` from the account binding list. On Bambu hardware this is the
   * printer serial, so callers MUST mask it before displaying or logging it.
   */
  id: string;
  name: string | null;
  model: string | null;
  online: boolean | null;
  printStatus: string | null;
}

const DEVICE_BIND_PATH = "/v1/iot-service/api/user/bind";
const PREFERENCE_PATH = "/v1/design-user-service/my/preference";
const TASKS_PATH = "/v1/user-service/my/tasks";
const CURRENT_PRINT_PATH = "/v1/iot-service/api/user/print?force=true";

/**
 * One bad optional field must not discard a whole device, so each optional
 * field falls back to `undefined` instead of failing the entry. Only `dev_id`
 * is load-bearing: without it there is nothing to select.
 */
const boundDeviceSchema = z.object({
  dev_id: z.string().min(1),
  name: z.string().min(1).optional().catch(undefined),
  dev_model_name: z.string().min(1).optional().catch(undefined),
  dev_product_name: z.string().min(1).optional().catch(undefined),
  online: z.boolean().optional().catch(undefined),
  print_status: z.string().min(1).optional().catch(undefined),
});

const bindResponseSchema = z.object({ devices: z.array(z.unknown()) });

/** Pure and total. A cloud shape change costs devices, never a crash. */
export function parseBoundDevices(payload: unknown): CloudDevice[] {
  const outer = bindResponseSchema.safeParse(payload);
  if (!outer.success) return [];

  const parsed: CloudDevice[] = [];
  for (const entry of outer.data.devices) {
    const device = boundDeviceSchema.safeParse(entry);
    if (!device.success) continue;
    const raw = device.data;
    parsed.push({
      id: raw.dev_id,
      name: raw.name ?? null,
      model: raw.dev_model_name ?? raw.dev_product_name ?? null,
      online: raw.online ?? null,
      printStatus: raw.print_status ?? null,
    });
  }
  return parsed;
}

export function preference(hosts: CloudHosts, token: string): Promise<Preference> {
  return request<Preference>(hosts, PREFERENCE_PATH, { token });
}

export async function listDevices(hosts: CloudHosts, token: string): Promise<CloudDevice[]> {
  return parseBoundDevices(await request<unknown>(hosts, DEVICE_BIND_PATH, { token }));
}

export function listTasks(
  hosts: CloudHosts,
  token: string,
  deviceId?: string,
  limit = 5,
): Promise<{ total: number; hits: unknown[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (deviceId) params.set("deviceId", deviceId);
  return request<{ total: number; hits: unknown[] }>(
    hosts,
    `${TASKS_PATH}?${params.toString()}`,
    { token },
  );
}

export function currentPrint(hosts: CloudHosts, token: string): Promise<unknown> {
  return request<unknown>(hosts, CURRENT_PRINT_PATH, { token });
}

/**
 * Pure normalizers for the two read-only Bambu Cloud HTTP device responses.
 *
 * The endpoints are reverse-engineered and may drift, so optional fields fail
 * independently and malformed entries never poison their well-formed siblings.
 * This module performs no request and retains no cloud identifier beyond the
 * map key needed by the coordinator.
 */

import { z } from "zod";
import type { CapabilitySet, PartialPrinterState } from "../types.ts";
import { clampPercent, fromTaskStatus } from "./state.ts";

export const CLOUD_HTTP_CAPABILITIES: CapabilitySet = {
  realtimeTelemetry: false,
  temperatures: false,
  filament: false,
  alerts: false,
  deviceDiscovery: true,
  projectMetadata: true,
  coverImage: false,
};

const bindDeviceSchema = z.object({
  dev_id: z.string().min(1),
  name: z.string().min(1).optional().catch(undefined),
  dev_model_name: z.string().min(1).optional().catch(undefined),
  dev_product_name: z.string().min(1).optional().catch(undefined),
  online: z.boolean().optional().catch(undefined),
  print_status: z.string().optional().catch(undefined),
});

const currentPrintDeviceSchema = z.object({
  dev_id: z.string().min(1),
  dev_name: z.string().min(1).optional().catch(undefined),
  dev_online: z.boolean().optional().catch(undefined),
  task_status: z.string().optional().catch(undefined),
  progress: z.number().finite().optional().catch(undefined),
  task_name: z.string().min(1).optional().catch(undefined),
});

const deviceListSchema = z.object({ devices: z.array(z.unknown()) });

/**
 * Identifiers such as task, project, model, and profile ids stop at this
 * boundary. So do `thumbnail` and the credential-bearing `dev_access_code`:
 * none is display state, and none belongs in a merged snapshot.
 *
 * No known HTTP endpoint supplies layer, remaining time, or temperature, so
 * those keys are deliberately never set here rather than filled with zero. As
 * of 2026-08-24, `/user/print` was observed to return no task fields at all —
 * not even `progress` — so in practice HTTP supplies identity and online state
 * and nothing more.
 *
 * `print_status` describes the *last job*, not the printer: an idle printer
 * reports `SUCCESS` indefinitely. `fromTaskStatus` is what keeps that from
 * rendering as "Finished" forever.
 *
 * An absent field is omitted rather than set to null. The coordinator treats a
 * null as news and would let it erase a value learned from the other endpoint,
 * so "the cloud did not mention the name this time" must not come out as "the
 * printer has no name".
 */
export function parseBindReport(payload: unknown): Map<string, PartialPrinterState> {
  const outer = deviceListSchema.safeParse(payload);
  if (!outer.success) return new Map();

  const devices = new Map<string, PartialPrinterState>();
  for (const entry of outer.data.devices) {
    const parsed = bindDeviceSchema.safeParse(entry);
    if (!parsed.success) continue;

    const raw = parsed.data;
    const printer: NonNullable<PartialPrinterState["printer"]> = {};
    if (raw.name !== undefined) printer.name = raw.name;
    const model = raw.dev_model_name ?? raw.dev_product_name;
    if (model !== undefined) printer.model = model;
    if (raw.online !== undefined) printer.online = raw.online;

    const fields: PartialPrinterState = {};
    if (Object.keys(printer).length > 0) fields.printer = printer;
    if (raw.print_status !== undefined) fields.job = fromTaskStatus(raw.print_status);

    devices.set(raw.dev_id, fields);
  }
  return devices;
}

export function parseCurrentPrint(
  payload: unknown,
  options: { exportJobName: boolean },
): Map<string, PartialPrinterState> {
  const outer = deviceListSchema.safeParse(payload);
  if (!outer.success) return new Map();

  const devices = new Map<string, PartialPrinterState>();
  for (const entry of outer.data.devices) {
    const parsed = currentPrintDeviceSchema.safeParse(entry);
    if (!parsed.success) continue;

    const raw = parsed.data;
    const printer: NonNullable<PartialPrinterState["printer"]> = {};
    if (raw.dev_name !== undefined) printer.name = raw.dev_name;
    if (raw.dev_online !== undefined) printer.online = raw.dev_online;

    const job: NonNullable<PartialPrinterState["job"]> = {};
    if (raw.task_status !== undefined) Object.assign(job, fromTaskStatus(raw.task_status));
    if (raw.progress !== undefined) job.progress = clampPercent(raw.progress);
    // Absent unless opted in, so this endpoint cannot even carry the name to
    // the next layer. The payload builder refuses it a second time.
    if (options.exportJobName && raw.task_name !== undefined) job.name = raw.task_name;

    const fields: PartialPrinterState = {};
    if (Object.keys(printer).length > 0) fields.printer = printer;
    if (Object.keys(job).length > 0) fields.job = job;

    devices.set(raw.dev_id, fields);
  }
  return devices;
}

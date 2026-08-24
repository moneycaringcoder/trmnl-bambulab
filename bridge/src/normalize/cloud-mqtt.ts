/**
 * Pure normalization for inbound Bambu Cloud MQTT `print` reports.
 *
 * Reports are untrusted, reverse-engineered input and P1-class printers send
 * deltas rather than complete objects. This module only reads reports: it has
 * no transport, encoder, request topic, or way to send anything to a printer.
 */

import { z } from "zod";
import type { CapabilitySet, PartialPrinterState } from "../types.ts";
import { clampPercent, toDisplayState } from "./state.ts";

export const CLOUD_MQTT_CAPABILITIES: CapabilitySet = {
  realtimeTelemetry: true,
  temperatures: true,
  filament: false,
  alerts: true,
  deviceDiscovery: false,
  projectMetadata: false,
  coverImage: false,
};

const stageCodeSchema = z
  .union([z.string().trim().min(1), z.number().finite()])
  .optional()
  .catch(undefined);

const printSchema = z.object({
  gcode_state: z.string().optional().catch(undefined),
  mc_percent: z.number().finite().optional().catch(undefined),
  layer_num: z.number().finite().optional().catch(undefined),
  total_layer_num: z.number().finite().optional().catch(undefined),
  mc_remaining_time: z.number().finite().optional().catch(undefined),
  stg_cur: stageCodeSchema,
  nozzle_temper: z.number().finite().optional().catch(undefined),
  nozzle_target_temper: z.number().finite().optional().catch(undefined),
  bed_temper: z.number().finite().optional().catch(undefined),
  bed_target_temper: z.number().finite().optional().catch(undefined),
  subtask_name: z.string().min(1).optional().catch(undefined),
  hms: z.array(z.unknown()).optional().catch(undefined),
  print_error: z.number().finite().int().optional().catch(undefined),
});

const reportSchema = z.object({ print: printSchema });
const hmsPairSchema = z.object({
  attr: z.number().finite().int(),
  code: z.number().finite().int(),
});

function eightDigitHex(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0xffffffff) return null;
  return (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function normalizeHmsEntry(value: unknown): string | null {
  const text = z.string().safeParse(value);
  if (text.success) {
    const compact = text.data
      .trim()
      .toUpperCase()
      .replace(/^HMS[_-]?/, "")
      .replaceAll("-", "")
      .replaceAll("_", "");
    if (!/^[0-9A-F]{16}$/.test(compact)) return null;
    return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12)}`;
  }

  const pair = hmsPairSchema.safeParse(value);
  if (!pair.success) return null;
  const attr = eightDigitHex(pair.data.attr);
  const code = eightDigitHex(pair.data.code);
  if (attr === null || code === null) return null;
  return `${attr.slice(0, 4)}-${attr.slice(4)}-${code.slice(0, 4)}-${code.slice(4)}`;
}

export function parseReport(
  payload: unknown,
  options?: { exportJobName: boolean },
): PartialPrinterState | null {
  const parsed = reportSchema.safeParse(payload);
  if (!parsed.success) return null;
  const raw = parsed.data.print;
  const fields: PartialPrinterState = {};

  const job: NonNullable<PartialPrinterState["job"]> = {};
  let hasJob = false;
  if (raw.gcode_state !== undefined) {
    const state = toDisplayState(raw.gcode_state);
    job.state = state.state;
    job.rawState = state.rawState;
    hasJob = true;
  }
  if (raw.mc_percent !== undefined) {
    job.progress = clampPercent(raw.mc_percent);
    hasJob = true;
  }
  if (raw.layer_num !== undefined || raw.total_layer_num !== undefined) {
    job.layer = {};
    if (raw.layer_num !== undefined) job.layer.current = raw.layer_num;
    if (raw.total_layer_num !== undefined) job.layer.total = raw.total_layer_num;
    hasJob = true;
  }
  if (raw.mc_remaining_time !== undefined) {
    job.remainingMinutes = raw.mc_remaining_time;
    hasJob = true;
  }
  if (raw.stg_cur !== undefined) {
    job.stageCode = String(raw.stg_cur);
    hasJob = true;
  }
  if (options?.exportJobName === true && raw.subtask_name !== undefined) {
    job.name = raw.subtask_name;
    hasJob = true;
  }
  if (hasJob) fields.job = job;

  const temperatures: NonNullable<PartialPrinterState["temperatures"]> = {};
  let hasTemperature = false;
  if (raw.nozzle_temper !== undefined) {
    temperatures.nozzle = Math.round(raw.nozzle_temper);
    hasTemperature = true;
  }
  if (raw.nozzle_target_temper !== undefined) {
    temperatures.nozzleTarget = Math.round(raw.nozzle_target_temper);
    hasTemperature = true;
  }
  if (raw.bed_temper !== undefined) {
    temperatures.bed = Math.round(raw.bed_temper);
    hasTemperature = true;
  }
  if (raw.bed_target_temper !== undefined) {
    temperatures.bedTarget = Math.round(raw.bed_target_temper);
    hasTemperature = true;
  }
  if (hasTemperature) fields.temperatures = temperatures;

  if (raw.hms !== undefined || raw.print_error !== undefined) {
    const alerts: NonNullable<PartialPrinterState["alerts"]> = {};
    let hmsCodes: string[] = [];
    if (raw.hms !== undefined) {
      hmsCodes = [];
      for (const entry of raw.hms) {
        const code = normalizeHmsEntry(entry);
        if (code !== null) hmsCodes.push(code);
        if (hmsCodes.length === 3) break;
      }
      alerts.hms = hmsCodes;
    }

    const printError =
      raw.print_error === undefined || raw.print_error === 0
        ? null
        : eightDigitHex(raw.print_error);
    if (raw.print_error !== undefined) alerts.printError = printError;
    alerts.active = hmsCodes.length > 0 || printError !== null;
    fields.alerts = alerts;
  }

  // Missing delta fields stay absent. Writing null here would erase a value
  // learned from an earlier P1 report, which is different from not observing it.
  return fields;
}

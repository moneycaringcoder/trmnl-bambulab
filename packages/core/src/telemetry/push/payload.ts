/**
 * The boundary between merged printer state and the TRMNL display contract.
 *
 * This module is pure: it has no network, filesystem, or clock access. It
 * deliberately exports neither internal printer keys nor field provenance, and
 * it sheds optional display detail in a fixed order rather than truncating JSON.
 */

import {
  MAX_PRINTERS_SHOWN,
  SCHEMA_VERSION,
  type DisplayState,
  type ProviderStatus,
  type Snapshot,
  type WebhookPayload,
  type WebhookPrinter,
  type WebhookVariables,
} from "../types.ts";
import { formatRemaining } from "../normalize/state.ts";

export interface PayloadOptions {
  /** Bridge clock, epoch milliseconds. */
  now: number;
  cloud: ProviderStatus;
  maxBytes: number;
  /** Job names can disclose private model names, so exporting is opt-in. */
  exportJobName: boolean;
}

export interface PayloadResult {
  /** Typed display variables, including nulls for honest in-process inspection. */
  variables: WebhookVariables;
  /** Typed webhook envelope. The wire form below omits its null-valued keys. */
  body: WebhookPayload;
  serialized: string;
  bytes: number;
  /** False means even the smallest permitted one-printer body exceeds the ceiling. */
  sendable: boolean;
  /** Optional detail removed, in the exact order it was removed. */
  shed: string[];
}

const STATE_PRIORITY: Record<DisplayState, number> = {
  printing: 0,
  paused: 1,
  preparing: 2,
  finished: 3,
  failed: 4,
  idle: 5,
  offline: 6,
  unknown: 7,
};

const UTF8 = new TextEncoder();

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareSnapshots(left: Snapshot, right: Snapshot): number {
  const stateDifference = STATE_PRIORITY[left.state.job.state] - STATE_PRIORITY[right.state.job.state];
  if (stateDifference !== 0) return stateDifference;

  const leftName = left.state.printer.name;
  const rightName = right.state.printer.name;
  if (leftName === null && rightName !== null) return 1;
  if (leftName !== null && rightName === null) return -1;
  if (leftName !== null && rightName !== null) {
    const foldedDifference = compareText(leftName.toLowerCase(), rightName.toLowerCase());
    if (foldedDifference !== 0) return foldedDifference;
    const exactDifference = compareText(leftName, rightName);
    if (exactDifference !== 0) return exactDifference;
  }

  // Internal keys make otherwise identical inputs deterministic, but never leave this module.
  return compareText(left.printerKey, right.printerKey);
}

function alertLine(snapshot: Snapshot): string | null {
  const alerts = [...snapshot.state.alerts.hms];
  if (snapshot.state.alerts.printError !== null) alerts.push(snapshot.state.alerts.printError);
  return alerts.length === 0 ? null : alerts.join(", ");
}

/**
 * Which states a progress percentage, a layer count and a countdown mean
 * something in.
 *
 * An idle printer holds whatever it last reported, so passing those numbers
 * through would show a ready printer that claims to be 87% through a job it
 * finished yesterday. `finished` and `failed` keep them, because "failed at
 * layer 47" is the useful part of a failure.
 */
const STATES_WITH_PRINT_METRICS: Record<DisplayState, boolean> = {
  printing: true,
  paused: true,
  preparing: true,
  finished: true,
  failed: true,
  idle: false,
  offline: false,
  unknown: false,
};

function toWebhookPrinter(snapshot: Snapshot, options: PayloadOptions): WebhookPrinter {
  const state = snapshot.state;
  const printing = STATES_WITH_PRINT_METRICS[state.job.state];
  return {
    state: state.job.state,
    raw_state: state.job.rawState,
    name: state.printer.name,
    model: state.printer.model,
    online: state.printer.online,
    // The coordinator decided this against its own window when it built the
    // snapshot. Recomputing it here would give two answers to one question.
    stale: state.printer.stale,
    progress: printing ? state.job.progress : null,
    layer: printing ? state.job.layer.current : null,
    layers: printing ? state.job.layer.total : null,
    remaining: printing ? formatRemaining(state.job.remainingMinutes) : null,
    stage: printing ? state.job.stage : null,
    // Temperatures are always real: an idle printer has a bed temperature, and
    // a warm bed is worth seeing.
    nozzle: state.temperatures.nozzle,
    nozzle_target: state.temperatures.nozzleTarget,
    bed: state.temperatures.bed,
    bed_target: state.temperatures.bedTarget,
    material: state.material.type,
    job: options.exportJobName && printing ? state.job.name : null,
    alert: alertLine(snapshot),
  };
}

function serialize(body: WebhookPayload): { serialized: string; bytes: number } {
  const serialized = JSON.stringify(body, (_key, value: unknown) =>
    value === null ? undefined : value,
  );
  if (serialized === undefined) throw new Error("webhook payload could not be serialized");
  return { serialized, bytes: UTF8.encode(serialized).byteLength };
}

function updatedAt(now: number): string {
  return `${new Date(now).toISOString().slice(0, 16)}Z`;
}

/**
 * Builds one bounded webhook body without exposing any internal identity.
 *
 * When necessary, detail is removed globally in this order: stage, target
 * temperatures, current temperatures, then the least-interesting printer. Once
 * the three detail classes are gone, further passes remove one printer at a
 * time. The final printer is never dropped: an oversized one-printer result is
 * returned with `sendable: false` so the caller cannot mistake it for a valid
 * empty display.
 */
export function buildWebhookPayload(
  snapshots: Snapshot[],
  options: PayloadOptions,
): PayloadResult {
  const ordered = [...snapshots].sort(compareSnapshots);
  const printers = ordered
    .slice(0, MAX_PRINTERS_SHOWN)
    .map((snapshot) => toWebhookPrinter(snapshot, options));
  const variables: WebhookVariables = {
    v: SCHEMA_VERSION,
    updated_at: updatedAt(options.now),
    printers,
    hidden: snapshots.length - printers.length,
    cloud: options.cloud,
  };
  const body: WebhookPayload = { merge_variables: variables };
  const shed: string[] = [];
  let wire = serialize(body);

  if (wire.bytes > options.maxBytes && printers.some((printer) => printer.stage !== null)) {
    for (const printer of printers) printer.stage = null;
    shed.push("stage");
    wire = serialize(body);
  }

  if (
    wire.bytes > options.maxBytes &&
    printers.some(
      (printer) => printer.nozzle_target !== null || printer.bed_target !== null,
    )
  ) {
    for (const printer of printers) {
      printer.nozzle_target = null;
      printer.bed_target = null;
    }
    shed.push("target_temperatures");
    wire = serialize(body);
  }

  if (
    wire.bytes > options.maxBytes &&
    printers.some((printer) => printer.nozzle !== null || printer.bed !== null)
  ) {
    for (const printer of printers) {
      printer.nozzle = null;
      printer.bed = null;
    }
    shed.push("current_temperatures");
    wire = serialize(body);
  }

  while (wire.bytes > options.maxBytes && printers.length > 1) {
    printers.pop();
    variables.hidden += 1;
    shed.push("printer");
    wire = serialize(body);
  }

  return {
    variables,
    body,
    serialized: wire.serialized,
    bytes: wire.bytes,
    sendable: wire.bytes <= options.maxBytes,
    shed,
  };
}

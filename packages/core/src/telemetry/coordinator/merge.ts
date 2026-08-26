/**
 * Merging observations into one view per printer.
 *
 * The bridge reads Bambu Cloud two ways. HTTP tells it which printers exist,
 * whether they are online, and roughly what they are doing. MQTT reports tell
 * it the things HTTP never mentions: layer counts, remaining time,
 * temperatures. Neither is sufficient, so both feed the same accumulated state
 * and this module decides what happens when they collide.
 *
 * Two rules do all the work.
 *
 * **A partial is a statement about the fields it contains, and about nothing
 * else.** A P1-class printer reports only what changed, so most reports are
 * nearly empty. An absent key means "no news", and no news must never erase
 * what we already knew.
 *
 * **When two sources disagree, the live one wins.** A cloud task can read as
 * running while the printer itself is reporting a pause, and letting the
 * coarser source overwrite the finer one would show a moving printer that is
 * actually stopped. So provider rank dominates, and time only breaks ties
 * within a rank. The one exception is silence: if the authoritative source has
 * said nothing for longer than `AUTHORITY_WINDOW_MS`, a coarser value is
 * better than a stale one.
 *
 * Pure module. `now` always arrives as part of an observation or as a
 * parameter, never from a clock, and every function returns new state rather
 * than mutating what it was given.
 */

import {
  type FieldProvenance,
  type Observation,
  type PrinterState,
  type ProviderId,
  type Snapshot,
} from "../types.ts";

/**
 * How authoritative each read path is. A live report from the printer beats a
 * summary the cloud assembled at its own pace.
 */
const RANK: Record<ProviderId, number> = {
  "cloud-mqtt": 2,
  "cloud-http": 1,
};

/**
 * How long a higher-ranked value keeps its priority after the last time that
 * source said anything. Past this, a lower-ranked source may overwrite it: a
 * printer that dropped off MQTT twenty minutes ago is better described by a
 * coarse cloud status than by what it was doing then.
 */
export const AUTHORITY_WINDOW_MS = 10 * 60 * 1000;

/**
 * How old the newest observation for a printer may be before the display is
 * told not to trust it. Three missed cycles at the five-minute cadence.
 */
export const STALE_AFTER_MS = 15 * 60 * 1000;

interface PrinterRecord {
  state: PrinterState;
  /** Keyed by dotted field path, for example `temperatures.nozzle`. */
  provenance: Record<string, FieldProvenance>;
}

export interface CoordinatorState {
  printers: Record<string, PrinterRecord>;
}

export function emptyCoordinatorState(): CoordinatorState {
  return { printers: {} };
}

/**
 * Everything unknown. This is what a printer the user chose but that has never
 * reported looks like, and it is deliberately not an idle printer: we have not
 * been told it is idle, only that we have not heard from it.
 */
export function unknownPrinterState(updatedAt: string): PrinterState {
  return {
    printer: { name: null, model: null, online: null, stale: true },
    job: {
      state: "unknown",
      rawState: null,
      name: null,
      progress: null,
      remainingMinutes: null,
      stage: null,
      stageCode: null,
      layer: { current: null, total: null },
    },
    temperatures: { nozzle: null, nozzleTarget: null, bed: null, bedTarget: null },
    material: { source: null, type: null, color: null },
    project: { coverUrl: null, weightGrams: null, lengthMm: null, bedType: null },
    alerts: { active: false, hms: [], printError: null },
    updatedAt,
  };
}

/**
 * Whether an incoming write to one field should be taken, given what is
 * already recorded there.
 */
function admits(
  existing: FieldProvenance | undefined,
  incoming: FieldProvenance,
): boolean {
  if (existing === undefined) return true;

  const existingRank = RANK[existing.providerId];
  const incomingRank = RANK[incoming.providerId];

  if (incomingRank > existingRank) return true;
  if (incomingRank === existingRank) return incoming.receivedAt >= existing.receivedAt;

  // A lower-ranked source is allowed in only once the authoritative one has
  // gone quiet for long enough that its value is the more misleading of the two.
  return incoming.receivedAt - existing.receivedAt > AUTHORITY_WINDOW_MS;
}

/**
 * Recursively copies present leaves from `incoming` into `target`, obeying
 * `admits` per leaf and recording where each accepted value came from.
 *
 * Arrays are leaves. `alerts.hms` is a set of codes that only makes sense
 * whole: merging two reports' code lists element by element would invent an
 * alert state that neither report described.
 */
function mergeInto(
  target: Record<string, unknown>,
  incoming: Record<string, unknown>,
  provenance: Record<string, FieldProvenance>,
  origin: FieldProvenance,
  prefix: string,
): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const path = prefix === "" ? key : `${prefix}.${key}`;

    const isBranch =
      typeof value === "object" && value !== null && !Array.isArray(value);
    if (isBranch) {
      const existing = target[key];
      const child =
        typeof existing === "object" && existing !== null && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : {};
      target[key] = child;
      mergeInto(child, value as Record<string, unknown>, provenance, origin, path);
      continue;
    }

    if (!admits(provenance[path], origin)) continue;
    target[key] = value;
    provenance[path] = origin;
  }
}

/**
 * Folds one observation into the accumulated state, returning new state.
 *
 * A printer the coordinator has not seen before is created on first mention,
 * so a printer appearing mid-run needs no separate registration step.
 */
export function accept(state: CoordinatorState, observation: Observation): CoordinatorState {
  const previous = state.printers[observation.printerKey];
  const merged: PrinterRecord = {
    state: structuredClone(
      previous?.state ?? unknownPrinterState(new Date(observation.receivedAt).toISOString()),
    ),
    provenance: { ...(previous?.provenance ?? {}) },
  };

  const origin: FieldProvenance = {
    providerId: observation.providerId,
    receivedAt: observation.receivedAt,
  };

  mergeInto(
    merged.state as unknown as Record<string, unknown>,
    observation.fields as Record<string, unknown>,
    merged.provenance,
    origin,
    "",
  );

  return { printers: { ...state.printers, [observation.printerKey]: merged } };
}

/** The newest `receivedAt` across every field, or null when nothing is known. */
function freshestAt(provenance: Record<string, FieldProvenance>): number | null {
  let newest: number | null = null;
  for (const entry of Object.values(provenance)) {
    if (newest === null || entry.receivedAt > newest) newest = entry.receivedAt;
  }
  return newest;
}

/**
 * One snapshot per requested printer, in the order requested.
 *
 * A requested printer with no observations still gets a snapshot. Dropping it
 * would make a printer the user explicitly chose disappear from their display
 * exactly when something is wrong, which is the moment they are most likely to
 * be looking at it.
 *
 * `printer.stale` and `updatedAt` are set here rather than merged from a
 * provider, because they describe the bridge's knowledge rather than the
 * printer's condition.
 */
export function snapshotsFor(
  state: CoordinatorState,
  printerKeys: readonly string[],
  nowMs: number,
): Snapshot[] {
  const updatedAt = new Date(nowMs).toISOString();

  return printerKeys.map((printerKey) => {
    const record = state.printers[printerKey];
    if (record === undefined) {
      return { printerKey, state: unknownPrinterState(updatedAt), provenance: {} };
    }

    const newest = freshestAt(record.provenance);
    const printerState = structuredClone(record.state);
    printerState.updatedAt = updatedAt;
    printerState.printer.stale = newest === null || nowMs - newest > STALE_AFTER_MS;

    return { printerKey, state: printerState, provenance: { ...record.provenance } };
  });
}

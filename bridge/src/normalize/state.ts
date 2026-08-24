/**
 * Turning Bambu's state tokens into something a display can say.
 *
 * Pure: no clock, no filesystem, no network. It never guesses that a missing or
 * unfamiliar token means idle; an unrecognized state stays visibly unknown,
 * because a printer whose state we cannot read must not render as a healthy
 * printer sitting ready.
 *
 * There are two functions rather than one because Bambu gives us two different
 * kinds of token that look identical and mean different things. Observed
 * against a real account on 2026-08-24:
 *
 *   - MQTT `gcode_state` is the printer's *live* state. `FINISH` there means it
 *     just finished.
 *   - HTTP `print_status` from `/user/bind` is the *last job's outcome*. An
 *     idle printer that last printed successfully reports `SUCCESS`, and keeps
 *     reporting it indefinitely.
 *
 * Feeding the second through the first's mapping is why an idle printer once
 * rendered as "Finished" forever.
 */

import type { DisplayState } from "../types.ts";

/** MQTT `gcode_state`: what the printer is doing right now. */
const LIVE_STATE_BY_TOKEN: Readonly<Record<string, DisplayState>> = {
  // Documented by OpenBambuAPI for `gcode_state`, and RUNNING is confirmed.
  IDLE: "idle",
  PREPARE: "preparing",
  RUNNING: "printing",
  PAUSE: "paused",
  FINISH: "finished",
  FAILED: "failed",
  SLICING: "preparing",
  OFFLINE: "offline",

  // Spelling variants community clients report for the same states.
  PAUSED: "paused",
  FINISHED: "finished",
  SUCCESS: "finished",
  FAILURE: "failed",
};

/**
 * HTTP `print_status`: what the last job did.
 *
 * A terminal outcome means the printer is not doing anything now, so it reads
 * as idle. That loses "the last print failed", and losing it is the point: a
 * printer showing "Failed" for the three days since a failed print is the same
 * error as showing "Finished" forever, in worse clothes. The raw token is
 * always preserved, so nothing is actually thrown away, and MQTT reports
 * `FINISH` at the moment it is true.
 */
const TERMINAL_TASK_TOKENS = new Set(["SUCCESS", "FINISH", "FINISHED", "FAILED", "FAILURE"]);

export interface NormalizedState {
  state: DisplayState;
  /** The provider's token, trimmed, kept even when unrecognized. */
  rawState: string | null;
}

/** For a live MQTT `gcode_state`. */
export function toDisplayState(rawToken: string | null | undefined): NormalizedState {
  const rawState = rawToken?.trim() ?? "";
  if (rawState === "") return { state: "unknown", rawState: null };

  return {
    state: LIVE_STATE_BY_TOKEN[rawState.toUpperCase()] ?? "unknown",
    rawState,
  };
}

/** For an HTTP `print_status` or `task_status`, which describe a job. */
export function fromTaskStatus(rawToken: string | null | undefined): NormalizedState {
  const rawState = rawToken?.trim() ?? "";
  if (rawState === "") return { state: "unknown", rawState: null };

  const token = rawState.toUpperCase();
  if (TERMINAL_TASK_TOKENS.has(token)) return { state: "idle", rawState };
  return { state: LIVE_STATE_BY_TOKEN[token] ?? "unknown", rawState };
}

export function formatRemaining(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return null;

  const wholeMinutes = Math.round(minutes);
  if (wholeMinutes === 0) return "<1m";
  if (wholeMinutes < 60) return `${wholeMinutes}m`;

  const wholeHours = Math.floor(wholeMinutes / 60);
  if (wholeHours < 24) {
    const minutePart = wholeMinutes % 60;
    return minutePart === 0 ? `${wholeHours}h` : `${wholeHours}h ${minutePart}m`;
  }

  const days = Math.floor(wholeHours / 24);
  const hourPart = wholeHours % 24;
  return hourPart === 0 ? `${days}d` : `${days}d ${hourPart}h`;
}

export function clampPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

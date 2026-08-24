/**
 * Small, provider-independent state and display normalizers.
 *
 * This module is pure: it reads no clock and reaches no filesystem or network.
 * In particular, it never guesses that a missing or unfamiliar printer state
 * means idle; an unsupported token must remain visibly unknown.
 */

import type { DisplayState } from "../types.ts";

const DISPLAY_STATE_BY_TOKEN: Readonly<Record<string, DisplayState>> = {
  // OpenBambuAPI documents these values for MQTT `gcode_state` reports.
  IDLE: "idle",
  PREPARE: "preparing",
  RUNNING: "printing",
  PAUSE: "paused",
  FINISH: "finished",
  FAILED: "failed",

  // The reverse-engineered HTTP `print_status` and `task_status` fields add these values.
  SLICING: "preparing",
  SUCCESS: "finished",
  OFFLINE: "offline",

  // Community clients report these spelling variants for the same Bambu states.
  PAUSED: "paused",
  FINISHED: "finished",
  FAILURE: "failed",
};

export function toDisplayState(
  rawToken: string | null | undefined,
): { state: DisplayState; rawState: string | null } {
  const rawState = rawToken?.trim() ?? "";
  if (rawState === "") return { state: "unknown", rawState: null };

  return {
    state: DISPLAY_STATE_BY_TOKEN[rawState.toUpperCase()] ?? "unknown",
    rawState,
  };
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

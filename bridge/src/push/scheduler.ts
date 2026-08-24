/**
 * Pure scheduling policy for TRMNL webhook pushes.
 *
 * This module decides whether a prepared body may spend the push budget and
 * records only successful pushes. It deliberately performs no I/O, reads no
 * clock, and knows nothing about HTTP failures or retries.
 */

const HOUR_MS = 3_600_000;

export const DEFAULT_HEARTBEAT_MS = 30 * 60_000;

export interface SchedulerState {
  readonly recentPushes: readonly number[];
  readonly lastSerialized: string | null;
  readonly lastPushedAt: number | null;
}

export interface PushCandidate {
  readonly serialized: string;
  readonly bytes: number;
  readonly sendable: boolean;
}

export interface SchedulerOptions {
  /** Caller-supplied clock, epoch milliseconds. */
  readonly now: number;
  readonly maxPushesPerHour: number;
  readonly maxPayloadBytes: number;
  readonly heartbeatMs?: number;
}

export type Decision =
  | { kind: "push"; reason: "changed" | "heartbeat" }
  | { kind: "skip"; reason: "unchanged" }
  | { kind: "skip"; reason: "rate-limited"; retryAfterMs: number }
  | { kind: "skip"; reason: "too-large"; bytes: number }
  | { kind: "skip"; reason: "not-sendable" };

const EMPTY_STATE: SchedulerState = Object.freeze({
  recentPushes: Object.freeze([]) as readonly number[],
  lastSerialized: null,
  lastPushedAt: null,
});

export function emptySchedulerState(): SchedulerState {
  return EMPTY_STATE;
}

function comparableBody(serialized: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return serialized;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return serialized;
  }

  const body = parsed as Record<string, unknown>;
  const mergeVariables = body.merge_variables;
  if (
    typeof mergeVariables !== "object" ||
    mergeVariables === null ||
    Array.isArray(mergeVariables)
  ) {
    return serialized;
  }

  // `updated_at` is generated from the clock, so comparing it would classify
  // every poll as changed even when the printer information is identical. The
  // scheduler owns freshness through its heartbeat; compare the serialized
  // wire body with only that scheduler-controlled marker removed.
  const comparableVariables = { ...(mergeVariables as Record<string, unknown>) };
  delete comparableVariables.updated_at;
  return JSON.stringify({ ...body, merge_variables: comparableVariables });
}

function rateLimitDelay(state: SchedulerState, options: SchedulerOptions): number | null {
  const cutoff = options.now - HOUR_MS;
  let pushesInWindow = 0;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;

  // A sliding hour prevents a clock-hour boundary from admitting twelve pushes
  // at 10:59 and another twelve at 11:01. Ignoring aged-out entries here, and
  // pruning them in `recordPush`, also keeps this record bounded over time.
  for (const pushedAt of state.recentPushes) {
    if (pushedAt <= cutoff) continue;
    pushesInWindow += 1;
    oldest = Math.min(oldest, pushedAt);
    newest = Math.max(newest, pushedAt);
  }

  if (pushesInWindow >= options.maxPushesPerHour) {
    return Math.max(0, Math.ceil(oldest + HOUR_MS - options.now));
  }

  if (pushesInWindow === 0) return null;

  // Spending the allowance evenly avoids using an entire busy hour's budget in
  // its first few minutes. Twelve pushes per hour therefore means one push no
  // sooner than every five minutes.
  const minimumSpacingMs = HOUR_MS / options.maxPushesPerHour;
  const spacingRemaining = newest + minimumSpacingMs - options.now;
  return spacingRemaining > 0 ? Math.ceil(spacingRemaining) : null;
}

export function decide(
  state: SchedulerState,
  candidate: PushCandidate,
  options: SchedulerOptions,
): Decision {
  // Size is an objective wire violation, even when the builder also marked the
  // candidate unsendable, so report it before any scheduling consideration.
  if (candidate.bytes > options.maxPayloadBytes) {
    return { kind: "skip", reason: "too-large", bytes: candidate.bytes };
  }
  if (!candidate.sendable) return { kind: "skip", reason: "not-sendable" };

  const unchanged =
    state.lastSerialized !== null &&
    comparableBody(candidate.serialized) === comparableBody(state.lastSerialized);
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const heartbeatDue =
    unchanged &&
    state.lastPushedAt !== null &&
    options.now - state.lastPushedAt >= heartbeatMs;

  // An unchanged body consumes scarce budget without altering the display.
  // Heartbeats are the exception because a stale freshness stamp is itself
  // misleading even when every printer value remains correct.
  if (unchanged && !heartbeatDue) return { kind: "skip", reason: "unchanged" };

  const retryAfterMs = rateLimitDelay(state, options);
  if (retryAfterMs !== null) {
    return { kind: "skip", reason: "rate-limited", retryAfterMs };
  }

  return { kind: "push", reason: heartbeatDue ? "heartbeat" : "changed" };
}

export function recordPush(
  state: SchedulerState,
  now: number,
  serialized: string,
): SchedulerState {
  const cutoff = now - HOUR_MS;
  const recentPushes = Object.freeze([
    ...state.recentPushes.filter((pushedAt) => pushedAt > cutoff),
    now,
  ]) as readonly number[];

  return Object.freeze({
    recentPushes,
    lastSerialized: serialized,
    lastPushedAt: now,
  });
}

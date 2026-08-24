import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEARTBEAT_MS,
  decide,
  emptySchedulerState,
  recordPush,
  type PushCandidate,
  type SchedulerOptions,
  type SchedulerState,
} from "../src/push/scheduler.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const BODY = JSON.stringify({
  merge_variables: {
    v: 1,
    updated_at: "2026-01-01T12:00Z",
    printers: [{ state: "idle", stale: false }],
    hidden: 0,
    cloud: "connected",
  },
});
const CHANGED_BODY = JSON.stringify({
  merge_variables: {
    v: 1,
    updated_at: "2026-01-01T12:05Z",
    printers: [{ state: "printing", stale: false, progress: 1 }],
    hidden: 0,
    cloud: "connected",
  },
});

function candidate(
  serialized = BODY,
  overrides: Partial<PushCandidate> = {},
): PushCandidate {
  return {
    serialized,
    bytes: Buffer.byteLength(serialized),
    sendable: true,
    ...overrides,
  };
}

function options(overrides: Partial<SchedulerOptions> = {}): SchedulerOptions {
  return {
    maxPushesPerHour: 12,
    maxPayloadBytes: 2_000,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    ...overrides,
  };
}

describe("push scheduler decisions", () => {
  it("always allows the first sendable body", () => {
    expect(decide(emptySchedulerState(), candidate(), options())).toEqual({
      kind: "push",
      reason: "changed",
    });
  });

  it("skips an identical body before its heartbeat is due", () => {
    const state = recordPush(emptySchedulerState(), NOW, BODY);

    expect(
      decide(state, candidate(), options({ now: NOW + 5 * MINUTE_MS })),
    ).toEqual({ kind: "skip", reason: "unchanged" });
  });

  it("allows a changed body after the minimum spacing", () => {
    const state = recordPush(emptySchedulerState(), NOW, BODY);

    expect(
      decide(state, candidate(CHANGED_BODY), options({ now: NOW + 5 * MINUTE_MS })),
    ).toEqual({ kind: "push", reason: "changed" });
  });

  it("pushes an identical body when the heartbeat becomes due", () => {
    const state = recordPush(emptySchedulerState(), NOW, BODY);

    expect(
      decide(state, candidate(), options({ now: NOW + DEFAULT_HEARTBEAT_MS })),
    ).toEqual({ kind: "push", reason: "heartbeat" });
  });

  it("enforces even spacing and reports the exact remaining delay", () => {
    const state = recordPush(emptySchedulerState(), NOW, BODY);

    expect(
      decide(
        state,
        candidate(CHANGED_BODY),
        options({ now: NOW + 90_000 }),
      ),
    ).toEqual({
      kind: "skip",
      reason: "rate-limited",
      retryAfterMs: 3 * MINUTE_MS + 30_000,
    });
  });

  it("refuses a full sliding-hour budget, then allows when the oldest push ages out", () => {
    let state: SchedulerState = emptySchedulerState();
    for (let index = 0; index < 12; index += 1) {
      const pushedAt = NOW + index * 5 * MINUTE_MS;
      state = recordPush(state, pushedAt, `${BODY}${index}`);
    }

    const beforeExpiry = NOW + HOUR_MS - 1;
    expect(
      decide(state, candidate(CHANGED_BODY), options({ now: beforeExpiry })),
    ).toEqual({
      kind: "skip",
      reason: "rate-limited",
      retryAfterMs: 1,
    });
    expect(
      decide(state, candidate(CHANGED_BODY), options({ now: NOW + HOUR_MS })),
    ).toEqual({ kind: "push", reason: "changed" });
  });

  it("refuses an oversized body before every other reason", () => {
    const state = recordPush(emptySchedulerState(), NOW, BODY);
    const oversized = candidate(BODY, { bytes: 2_001, sendable: false });

    expect(decide(state, oversized, options())).toEqual({
      kind: "skip",
      reason: "too-large",
      bytes: 2_001,
    });
  });

  it("refuses a candidate the payload builder marked unsendable", () => {
    expect(
      decide(
        emptySchedulerState(),
        candidate(BODY, { sendable: false }),
        options(),
      ),
    ).toEqual({ kind: "skip", reason: "not-sendable" });
  });

  it("treats a body differing only in updated_at as unchanged", () => {
    const state = recordPush(emptySchedulerState(), NOW, BODY);
    const laterTimestamp = BODY.replace(
      "2026-01-01T12:00Z",
      "2026-01-01T12:05Z",
    );

    expect(
      decide(
        state,
        candidate(laterTimestamp),
        options({ now: NOW + 5 * MINUTE_MS }),
      ),
    ).toEqual({ kind: "skip", reason: "unchanged" });
  });
});

describe("push scheduler state", () => {
  it("keeps only the trailing hour after many pushes over many hours", () => {
    const start = NOW - 10 * HOUR_MS;
    let state: SchedulerState = emptySchedulerState();

    for (let index = 0; index <= 120; index += 1) {
      state = recordPush(state, start + index * 5 * MINUTE_MS, BODY);
    }

    expect(state.recentPushes).toHaveLength(12);
    expect(state.recentPushes[0]).toBe(NOW - 55 * MINUTE_MS);
    expect(state.recentPushes.at(-1)).toBe(NOW);
  });

  it("returns immutable records without changing the prior state", () => {
    const empty = emptySchedulerState();
    const recorded = recordPush(empty, NOW, BODY);

    expect(empty).toEqual({
      recentPushes: [],
      lastSerialized: null,
      lastPushedAt: null,
    });
    expect(recorded).toEqual({
      recentPushes: [NOW],
      lastSerialized: BODY,
      lastPushedAt: NOW,
    });
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(Object.isFrozen(recorded.recentPushes)).toBe(true);
  });
});

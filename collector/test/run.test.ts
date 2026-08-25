/**
 * Reconnection backoff.
 *
 * Bambu has temporarily banned accounts for reconnect storms, so the bounds here
 * are a safety property rather than a tuning preference. The account loop itself
 * is exercised against real Postgres and the real cloud, so what is pinned here
 * is the arithmetic: that it climbs, that it stops climbing, and that it never
 * returns a delay short enough to be a storm.
 */

import { describe, expect, it } from "vitest";
import { backoffMs } from "../src/run.ts";

/** Full jitter halves the ceiling at worst, so this is the floor of any delay. */
const FIRST_CEILING = 5_000;
const CAP = 5 * 60_000;

describe("backoff", () => {
  it("never returns a delay short enough to be a storm", () => {
    for (let failures = 1; failures <= 40; failures += 1) {
      for (const random of [0, 0.5, 0.999]) {
        const delay = backoffMs(failures, () => random);
        expect(delay).toBeGreaterThanOrEqual(FIRST_CEILING / 2);
      }
    }
  });

  it("climbs with consecutive failures", () => {
    // Compared at a fixed jitter, because the point is the ceiling moving rather
    // than one draw beating another.
    const delays = [1, 2, 3, 4, 5].map((failures) => backoffMs(failures, () => 1));
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThan(delays[index - 1] ?? 0);
    }
  });

  it("stops climbing at the cap", () => {
    // A delay that kept doubling would eventually park a collector for hours,
    // which is indistinguishable from it being dead.
    for (const failures of [20, 100, 1_000]) {
      expect(backoffMs(failures, () => 1)).toBe(CAP);
    }
  });

  it("stays within the cap for every jitter draw", () => {
    for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(backoffMs(50, () => random)).toBeLessThanOrEqual(CAP);
    }
  });

  it("spreads restarts rather than synchronising them", () => {
    // Instances that all restarted together would reconnect together without
    // this, which is the shape that looks like an attack from the far end.
    const draws = [0, 0.2, 0.4, 0.6, 0.8, 0.999].map((random) =>
      backoffMs(4, () => random),
    );
    expect(new Set(draws).size).toBe(draws.length);
  });
});

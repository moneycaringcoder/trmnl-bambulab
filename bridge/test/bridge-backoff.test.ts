import { describe, expect, it } from "vitest";
import {
  FIRST_RETRY_MS,
  MAX_RETRY_MS,
  isRetryable,
  retryDelayMs,
} from "../src/bridge/backoff.ts";

describe("retryDelayMs", () => {
  it("does not wait before the first attempt", () => {
    expect(retryDelayMs(0)).toBe(0);
  });

  it("doubles from five seconds", () => {
    // Jitter at its maximum, so the schedule itself is what is under test.
    const full = () => 1;
    expect(retryDelayMs(1, full)).toBe(FIRST_RETRY_MS);
    expect(retryDelayMs(2, full)).toBe(2 * FIRST_RETRY_MS);
    expect(retryDelayMs(3, full)).toBe(4 * FIRST_RETRY_MS);
  });

  it("stops doubling at the ceiling", () => {
    const full = () => 1;
    expect(retryDelayMs(20, full)).toBe(MAX_RETRY_MS);
    expect(retryDelayMs(200, full)).toBe(MAX_RETRY_MS);
  });

  // Every bridge that lost its connection in the same cloud incident would
  // otherwise come back at the same instant, which is the behaviour Bambu's
  // own notice blames for the bans.
  it("spreads each delay across half its window", () => {
    expect(retryDelayMs(4, () => 0)).toBe(20_000);
    expect(retryDelayMs(4, () => 1)).toBe(40_000);
  });

  it("never returns a negative or fractional delay", () => {
    for (let failures = 1; failures <= 12; failures += 1) {
      for (const random of [0, 0.37, 0.5, 0.99, 1]) {
        const delay = retryDelayMs(failures, () => random);
        expect(delay).toBeGreaterThan(0);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeLessThanOrEqual(MAX_RETRY_MS);
      }
    }
  });
});

describe("isRetryable", () => {
  // Retrying a refused token cannot succeed, and looping against a rejecting
  // endpoint is what earns an account a temporary ban.
  it("refuses to retry a rejection that cannot succeed", () => {
    expect(isRetryable("rejected")).toBe(false);
    expect(isRetryable("reauth_required")).toBe(false);
  });

  it("retries a connection that merely ended", () => {
    expect(isRetryable("closed-by-broker")).toBe(true);
    expect(isRetryable("failed")).toBe(true);
  });
});

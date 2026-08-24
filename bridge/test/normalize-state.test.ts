import { describe, expect, it } from "vitest";
import { clampPercent, formatRemaining, toDisplayState } from "../src/normalize/state.ts";

describe("toDisplayState", () => {
  it.each([
    ["IDLE", "idle"],
    ["PREPARE", "preparing"],
    ["SLICING", "preparing"],
    ["RUNNING", "printing"],
    ["PAUSE", "paused"],
    ["PAUSED", "paused"],
    ["FINISH", "finished"],
    ["FINISHED", "finished"],
    ["SUCCESS", "finished"],
    ["FAILED", "failed"],
    ["FAILURE", "failed"],
    ["OFFLINE", "offline"],
  ] as const)("maps %s to %s", (rawState, state) => {
    expect(toDisplayState(rawState)).toEqual({ state, rawState });
  });

  it("matches case-insensitively while preserving the trimmed caller token", () => {
    expect(toDisplayState("  running  ")).toEqual({ state: "printing", rawState: "running" });
  });

  it("preserves an unrecognized token instead of guessing idle", () => {
    expect(toDisplayState("  CALIBRATING  ")).toEqual({
      state: "unknown",
      rawState: "CALIBRATING",
    });
  });

  it("treats missing and empty tokens as unknown with no raw value", () => {
    expect(toDisplayState(null)).toEqual({ state: "unknown", rawState: null });
    expect(toDisplayState(undefined)).toEqual({ state: "unknown", rawState: null });
    expect(toDisplayState("   ")).toEqual({ state: "unknown", rawState: null });
  });
});

describe("formatRemaining", () => {
  it.each([
    [0, "<1m"],
    [7, "7m"],
    [59, "59m"],
    [60, "1h"],
    [61, "1h 1m"],
    [76, "1h 16m"],
    [1_440, "1d"],
    [3_060, "2d 3h"],
  ] as const)("formats %i minutes as %s", (minutes, expected) => {
    expect(formatRemaining(minutes)).toBe(expected);
  });

  it("rejects absent, negative, and non-finite values", () => {
    expect(formatRemaining(null)).toBeNull();
    expect(formatRemaining(-1)).toBeNull();
    expect(formatRemaining(Number.NaN)).toBeNull();
    expect(formatRemaining(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("clampPercent", () => {
  it("rounds display percentages and clamps the CSS-safe range", () => {
    expect(clampPercent(42.6)).toBe(43);
    expect(clampPercent(101)).toBe(100);
    expect(clampPercent(-1)).toBe(0);
  });

  it("returns null for absent and non-finite values", () => {
    expect(clampPercent(null)).toBeNull();
    expect(clampPercent(undefined)).toBeNull();
    expect(clampPercent(Number.NaN)).toBeNull();
    expect(clampPercent(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

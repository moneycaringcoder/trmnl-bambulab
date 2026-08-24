import { describe, expect, it } from "vitest";
import {
  EXPIRY_WARN_WINDOW_MS,
  decodeTokenClaims,
  isJwtShaped,
  mqttUsernameForUid,
  mqttUsernameFromToken,
  tokenExpiry,
  tokenState,
} from "../src/providers/bambu-cloud/token.ts";
import { secondsFrom, syntheticToken } from "./synthetic-values.ts";

const NOW = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;

describe("isJwtShaped", () => {
  it("recognizes a readable JWT and declines to guess about anything else", () => {
    expect(isJwtShaped(syntheticToken({ username: "u_1" }))).toBe(true);
    expect(isJwtShaped("  a.b.c  ")).toBe(true);
    expect(isJwtShaped("a.b")).toBe(false);
    expect(isJwtShaped("a..c")).toBe(false);
    expect(isJwtShaped("")).toBe(false);
  });
});

describe("decodeTokenClaims", () => {
  it("reads the username and expiry claims", () => {
    const token = syntheticToken({ username: "u_4242", exp: secondsFrom(NOW, DAY) });
    expect(decodeTokenClaims(token)).toEqual({
      username: "u_4242",
      expiresAt: secondsFrom(NOW, DAY) * 1000,
    });
  });

  it("keeps only a u_<digits> username", () => {
    expect(decodeTokenClaims(syntheticToken({ username: "alice" })).username).toBeNull();
    expect(decodeTokenClaims(syntheticToken({ username: 7 })).username).toBeNull();
  });

  it("never throws on an unreadable token", () => {
    expect(decodeTokenClaims("not-a-token")).toEqual({ username: null, expiresAt: null });
    expect(decodeTokenClaims("aaa.!!!not-base64-json!!!.ccc")).toEqual({
      username: null,
      expiresAt: null,
    });
    expect(decodeTokenClaims("")).toEqual({ username: null, expiresAt: null });
  });

  it("ignores a non-numeric expiry", () => {
    expect(decodeTokenClaims(syntheticToken({ exp: "soon" })).expiresAt).toBeNull();
  });
});

describe("mqttUsernameFromToken", () => {
  it("returns the cloud MQTT username when the token carries one", () => {
    expect(mqttUsernameFromToken(syntheticToken({ username: "u_1234567" }))).toBe("u_1234567");
  });

  it("returns null rather than throwing, so the caller can ask the cloud", () => {
    expect(mqttUsernameFromToken(syntheticToken({ sub: "u_1" }))).toBeNull();
    expect(mqttUsernameFromToken("an-opaque-token")).toBeNull();
  });
});

describe("mqttUsernameForUid", () => {
  it("formats an account id", () => {
    expect(mqttUsernameForUid(1234567)).toBe("u_1234567");
  });

  it("refuses an id that cannot be an account", () => {
    expect(() => mqttUsernameForUid(0)).toThrow(/positive integer/);
    expect(() => mqttUsernameForUid(-1)).toThrow(/positive integer/);
    expect(() => mqttUsernameForUid(1.5)).toThrow(/positive integer/);
  });
});

describe("tokenExpiry", () => {
  it("returns epoch milliseconds", () => {
    const token = syntheticToken({ exp: secondsFrom(NOW, 2 * DAY) });
    expect(tokenExpiry(token)).toBe(secondsFrom(NOW, 2 * DAY) * 1000);
  });

  it("returns null without an exp claim", () => {
    expect(tokenExpiry(syntheticToken({ username: "u_1" }))).toBeNull();
  });
});

describe("tokenState", () => {
  it("is valid well before expiry", () => {
    const token = syntheticToken({ exp: secondsFrom(NOW, 30 * DAY) });
    expect(tokenState(token, NOW)).toEqual({
      kind: "valid",
      expiresAt: secondsFrom(NOW, 30 * DAY) * 1000,
    });
  });

  it("warns inside the expiry window", () => {
    const token = syntheticToken({ exp: secondsFrom(NOW, EXPIRY_WARN_WINDOW_MS - DAY) });
    expect(tokenState(token, NOW).kind).toBe("expiring-soon");
  });

  it("is expired at and after the expiry instant", () => {
    const token = syntheticToken({ exp: secondsFrom(NOW, 0) });
    expect(tokenState(token, NOW).kind).toBe("expired");
    expect(tokenState(token, NOW + DAY).kind).toBe("expired");
  });

  it("treats an opaque token as unknown expiry, not as a fault", () => {
    expect(tokenState(syntheticToken({ username: "u_1" }), NOW)).toEqual({ kind: "unknown-expiry" });
    expect(tokenState("an-opaque-token", NOW)).toEqual({ kind: "unknown-expiry" });
    expect(tokenState("two.segments", NOW)).toEqual({ kind: "unknown-expiry" });
  });
});

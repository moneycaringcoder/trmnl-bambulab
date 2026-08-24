import { describe, expect, it } from "vitest";
import {
  EXPIRY_WARN_WINDOW_MS,
  decodeTokenClaims,
  looksLikeAccessToken,
  mqttUsernameFromToken,
  tokenExpiry,
  tokenState,
} from "../src/providers/bambu-cloud/token.ts";
import { secondsFrom, syntheticToken } from "./synthetic-values.ts";

const NOW = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;

describe("looksLikeAccessToken", () => {
  it("accepts a three-segment token and rejects anything else", () => {
    expect(looksLikeAccessToken(syntheticToken({ username: "u_1" }))).toBe(true);
    expect(looksLikeAccessToken("  a.b.c  ")).toBe(true);
    expect(looksLikeAccessToken("a.b")).toBe(false);
    expect(looksLikeAccessToken("a..c")).toBe(false);
    expect(looksLikeAccessToken("")).toBe(false);
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
  it("returns the cloud MQTT username", () => {
    expect(mqttUsernameFromToken(syntheticToken({ username: "u_1234567" }))).toBe("u_1234567");
  });

  it("throws when the claim is missing", () => {
    expect(() => mqttUsernameFromToken(syntheticToken({ sub: "u_1" }))).toThrow(
      /no usable username claim/,
    );
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

  it("separates an absent expiry from an unreadable token", () => {
    expect(tokenState(syntheticToken({ username: "u_1" }), NOW)).toEqual({ kind: "unknown-expiry" });
    expect(tokenState("two.segments", NOW)).toEqual({ kind: "malformed" });
  });
});

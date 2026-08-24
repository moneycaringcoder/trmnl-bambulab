/**
 * Access token claim parsing.
 *
 * Decoding a JWT payload is NOT verification. Nothing here checks a signature,
 * and no claim is trusted for authorization. Two claims are read, for two
 * narrow reasons:
 *
 *   - `username`, of the form `u_<digits>`, is the cloud MQTT username.
 *   - `exp` drives the explicit `reauth_required` state, so an expired token
 *     surfaces as an instruction to the user instead of a silent retry loop.
 *
 * Pure module: `now` is always a parameter, never a clock read.
 */

export interface TokenClaims {
  username: string | null;
  /** Epoch milliseconds, or null when the token carries no usable `exp`. */
  expiresAt: number | null;
}

export type TokenState =
  | { kind: "valid"; expiresAt: number }
  | { kind: "expiring-soon"; expiresAt: number }
  | { kind: "expired"; expiresAt: number }
  | { kind: "unknown-expiry" }
  | { kind: "malformed" };

/** A token inside this window still works but setup should warn about it. */
export const EXPIRY_WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function looksLikeAccessToken(value: string): boolean {
  const segments = value.trim().split(".");
  return segments.length === 3 && segments.every((segment) => segment.length > 0);
}

/** Never throws. An unreadable token yields nulls, not an exception. */
export function decodeTokenClaims(token: string): TokenClaims {
  const empty: TokenClaims = { username: null, expiresAt: null };
  if (!looksLikeAccessToken(token)) return empty;
  const segment = token.trim().split(".")[1];
  if (segment === undefined) return empty;
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const claims = JSON.parse(json) as { username?: unknown; exp?: unknown };
    return {
      username:
        typeof claims.username === "string" && /^u_\d+$/.test(claims.username)
          ? claims.username
          : null,
      expiresAt:
        typeof claims.exp === "number" && Number.isFinite(claims.exp)
          ? claims.exp * 1000
          : null,
    };
  } catch {
    return empty;
  }
}

/** Throws when the token carries no usable `u_<digits>` username claim. */
export function mqttUsernameFromToken(token: string): string {
  const { username } = decodeTokenClaims(token);
  if (username === null) {
    throw new Error("access token payload has no usable username claim");
  }
  return username;
}

export function tokenExpiry(token: string): number | null {
  return decodeTokenClaims(token).expiresAt;
}

export function tokenState(token: string, nowMs: number): TokenState {
  if (!looksLikeAccessToken(token)) return { kind: "malformed" };
  const { expiresAt } = decodeTokenClaims(token);
  if (expiresAt === null) return { kind: "unknown-expiry" };
  if (expiresAt <= nowMs) return { kind: "expired", expiresAt };
  if (expiresAt - nowMs <= EXPIRY_WARN_WINDOW_MS) {
    return { kind: "expiring-soon", expiresAt };
  }
  return { kind: "valid", expiresAt };
}

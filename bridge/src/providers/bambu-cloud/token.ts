/**
 * Access token claim parsing.
 *
 * A Bambu access token is treated as opaque. Some are JWT-shaped and some are
 * not: Bambu's own notes say the MQTT username is no longer carried in access
 * tokens, which means the format has already changed at least once. So nothing
 * here decides whether a token is acceptable. It only reads what a token
 * happens to volunteer, and every caller has a fallback for when it volunteers
 * nothing.
 *
 * Decoding a JWT payload is NOT verification. Nothing here checks a signature,
 * and no claim is trusted for authorization. Two claims are read, for two
 * narrow reasons:
 *
 *   - `username`, of the form `u_<digits>`, is the cloud MQTT username. When it
 *     is absent, `GET /v1/design-user-service/my/preference` supplies the
 *     account id instead and `mqttUsernameForUid` formats it.
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
  /** Opaque, or JWT-shaped with no usable `exp`. Expiry surfaces on refusal. */
  | { kind: "unknown-expiry" };

/** A token inside this window still works but setup should warn about it. */
export const EXPIRY_WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a token can be read as a JWT. A hint for parsing, never a test of
 * validity: an opaque token that the cloud just issued is perfectly good.
 */
export function isJwtShaped(value: string): boolean {
  const segments = value.trim().split(".");
  return segments.length === 3 && segments.every((segment) => segment.length > 0);
}

/** Never throws. An opaque or unreadable token yields nulls. */
export function decodeTokenClaims(token: string): TokenClaims {
  const empty: TokenClaims = { username: null, expiresAt: null };
  if (!isJwtShaped(token)) return empty;
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

/**
 * The cloud MQTT username when the token volunteers it, else null. A null is
 * routine rather than exceptional: the caller reads the account id from
 * `/v1/design-user-service/my/preference` and uses `mqttUsernameForUid`.
 */
export function mqttUsernameFromToken(token: string): string | null {
  return decodeTokenClaims(token).username;
}

export function mqttUsernameForUid(uid: number): string {
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error("cloud account id is not a usable positive integer");
  }
  return `u_${uid}`;
}

export function tokenExpiry(token: string): number | null {
  return decodeTokenClaims(token).expiresAt;
}

export function tokenState(token: string, nowMs: number): TokenState {
  const { expiresAt } = decodeTokenClaims(token);
  if (expiresAt === null) return { kind: "unknown-expiry" };
  if (expiresAt <= nowMs) return { kind: "expired", expiresAt };
  if (expiresAt - nowMs <= EXPIRY_WARN_WINDOW_MS) {
    return { kind: "expiring-soon", expiresAt };
  }
  return { kind: "valid", expiresAt };
}

/**
 * Verifying a hosted user's session, so enrolment can know who is asking.
 *
 * `AGENTS.md` requires hosted identity to come from a hosted identity provider
 * and forbids storing passwords. The provider is Neon Auth, which is managed
 * Better Auth: a signed-in browser holds an opaque `HttpOnly` session cookie and
 * can exchange it for a short-lived signed token, which it sends here as a
 * bearer credential. Nothing in this file ever sees a password.
 *
 * Verification is a local signature check against the provider's published
 * JWKS. The alternative — asking the provider to introspect each token, or
 * reading the session row out of Postgres — would add a network round trip to
 * every enrolment request, and Neon documents no introspection route.
 *
 * Four decisions worth stating, because the cheap version of each is a
 * vulnerability rather than a shortcut:
 *
 * **The algorithm is pinned, never read from the token.** A verifier that
 * selects its algorithm from the token's own `alg` header lets the sender choose
 * how they will be checked, which is the classic JWT forgery. Ed25519 is what
 * the provider issues and the only thing accepted here; `none`, HMAC, and RSA
 * are refused before any key is touched.
 *
 * **A cache miss cannot be used to make us fetch.** Keys are looked up by `kid`
 * and an unknown `kid` triggers a refetch, which is the documented way to pick
 * up a rotated key. Left there, it is also a way for anyone to make us issue an
 * outbound request per forged token, so refetching is itself rate limited and a
 * flood of unknown key ids costs one fetch rather than thousands.
 *
 * **Only the subject survives.** The provider's token also carries `email` and
 * `name`. `AGENTS.md` forbids logging an email, and the reliable way to honour
 * that is to not carry one: this module returns an opaque subject and discards
 * every other claim, so no later caller can leak what it never received.
 *
 * **Issuer and audience are derived, not configured.** Both equal the origin of
 * the configured base URL, so there is no second setting to get wrong and no
 * way to deploy a verifier that accepts tokens from somewhere else.
 */

/**
 * Ed25519, and nothing else. Named once so the pin cannot drift.
 *
 * The curve and the Web Crypto algorithm happen to share a spelling, and they
 * are separate names in separate registries: RFC 8037 names the JWK curve, the
 * runtime names the algorithm. Kept apart so a future runtime rename does not
 * silently change which curve is accepted.
 */
const ALGORITHM = "Ed25519";
const CURVE = "Ed25519";
const JWT_ALG = "EdDSA";
const JWKS_PATH = "/.well-known/jwks.json";

/**
 * Tolerance for clock disagreement between the provider and this Worker.
 *
 * Small on purpose. The provider issues tokens that live fifteen minutes, so a
 * generous skew would meaningfully extend a token's life past revocation.
 */
const CLOCK_SKEW_MS = 30_000;

/**
 * How long a fetched key set is trusted before it is re-read.
 *
 * Staleness only: a key already held keeps working, and this governs when we
 * look for changes without being prompted.
 */
export const JWKS_TTL_MS = 5 * 60_000;

/**
 * The floor between refetches triggered by a key id we do not hold.
 *
 * This number is the whole compromise between two failure modes, and getting it
 * wrong in either direction is expensive. Refetch on every unknown id, and any
 * anonymous caller turns one forged token into one outbound request, and a
 * flood of them into a flood of requests. Never refetch before the TTL, and a
 * key rotation rejects every session signed by the new key for up to five
 * minutes, which is an outage caused by a routine provider operation.
 *
 * Thirty seconds bounds the forged-id cost to two requests a minute while
 * making a rotation invisible to all but a few seconds of traffic.
 */
export const JWKS_MISS_COOLDOWN_MS = 30_000;

export interface SessionIdentity {
  /**
   * The provider's user id, opaque to us.
   *
   * Never stored raw: the store keeps a keyed tag of it, because the provider
   * does not document this value's entropy and a bare hash of a guessable
   * identifier would be reversible by dictionary attack.
   */
  subject: string;
}

export type SessionOutcome =
  | { kind: "identified"; identity: SessionIdentity }
  /** No usable credential was presented. */
  | { kind: "anonymous" }
  /** A credential was presented and is not acceptable. */
  | { kind: "rejected"; reason: RejectionReason }
  /** Identity is not configured, so no request can be authenticated. */
  | { kind: "unconfigured" };

/**
 * Why a token failed, for a test to assert on and for a metric to count.
 *
 * Deliberately coarse and never returned to the caller in a response body: a
 * client that learns *why* its forgery failed learns how to improve it.
 */
export type RejectionReason =
  | "malformed"
  | "wrong-algorithm"
  | "unknown-key"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "wrong-issuer"
  | "no-subject";

/** A parsed JSON Web Key we are willing to use: an Ed25519 public key. */
interface OkpKey {
  kid: string;
  key: CryptoKey;
}

export interface SessionConfig {
  /**
   * The provider's base URL, for example `https://ep-x.aws.neon.tech/db/auth`.
   *
   * Absent means identity is not provisioned, and every authenticated route
   * refuses rather than falling back to trusting the caller.
   */
  baseUrl: string | undefined;
  /** Override for tests. Defaults to the runtime's own `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override for tests, so a clock is never read implicitly. */
  now: number;
}

/**
 * A verifier holding a key cache.
 *
 * An object rather than module-level state so a test can have its own, and so
 * two configurations cannot contaminate each other's keys. One instance per
 * Worker isolate is the intended production shape: the cache is what keeps
 * verification local.
 */
export class SessionVerifier {
  private readonly origin: string | null;
  private readonly jwksUrl: string | null;
  private readonly fetchImpl: typeof fetch;

  private keys: Map<string, OkpKey> = new Map();
  /** Epoch ms of the last completed fetch attempt, successful or not. */
  private fetchedAt = 0;
  /** In-flight fetch, so concurrent requests share one outbound call. */
  private inFlight: Promise<void> | null = null;

  constructor(config: { baseUrl: string | undefined; fetchImpl?: typeof fetch }) {
    const base = config.baseUrl?.trim() ?? "";
    if (base === "") {
      this.origin = null;
      this.jwksUrl = null;
    } else {
      const url = new URL(base);
      // Both `iss` and `aud` are the origin rather than the full base path, so
      // they are derived here once and never configured separately.
      this.origin = url.origin;
      // The JWKS lives under the full base path, which is not the origin.
      this.jwksUrl = `${base.replace(/\/+$/, "")}${JWKS_PATH}`;
    }
    // Wrapped, not assigned. Storing the global `fetch` on a field and calling
    // it as `this.fetchImpl(...)` invokes it with the wrong receiver, which the
    // Workers runtime rejects even though Node tolerates it. The failure was
    // invisible: the throw landed in the catch that exists to survive a provider
    // outage, so every session was refused with `unknown-key` while the key set
    // stayed silently empty.
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get configured(): boolean {
    return this.origin !== null;
  }

  /**
   * Verifies an `Authorization` header and reports who is asking.
   *
   * A missing header is `anonymous` rather than `rejected`: a caller that
   * presented nothing has not failed a check, and the distinction lets a route
   * answer an unauthenticated request differently from a forged one.
   */
  async identify(authorization: string | null, now: number): Promise<SessionOutcome> {
    if (this.origin === null) return { kind: "unconfigured" };

    const token = bearerToken(authorization);
    if (token === null) return { kind: "anonymous" };

    const parts = token.split(".");
    if (parts.length !== 3) return reject("malformed");
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined
    ) {
      return reject("malformed");
    }

    const header = decodeJson(encodedHeader);
    if (header === null) return reject("malformed");

    // Pinned, not selected. `none` and every symmetric algorithm land here.
    if (header["alg"] !== JWT_ALG) return reject("wrong-algorithm");
    const kid = header["kid"];
    if (typeof kid !== "string" || kid === "") return reject("unknown-key");

    const key = await this.keyFor(kid, now);
    if (key === null) return reject("unknown-key");

    const signature = decodeBase64Url(encodedSignature);
    if (signature === null) return reject("malformed");

    // Signature before claims, always. Reading claims out of an unverified
    // token and acting on them is how a verifier becomes decorative.
    const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
    const valid = await crypto.subtle.verify(ALGORITHM, key.key, signature, signed);
    if (!valid) return reject("bad-signature");

    const payload = decodeJson(encodedPayload);
    if (payload === null) return reject("malformed");

    // The origin travels as an argument rather than being re-read from the
    // field, so the null case is excluded by the type rather than by trusting
    // that the guard at the top of this method still runs first.
    return this.checkClaims(payload, this.origin, now);
  }

  private checkClaims(
    payload: Record<string, unknown>,
    origin: string,
    now: number,
  ): SessionOutcome {
    if (payload["iss"] !== origin) return reject("wrong-issuer");
    if (!audienceMatches(payload["aud"], origin)) return reject("wrong-issuer");

    const exp = numeric(payload["exp"]);
    // An absent expiry is a token that never dies, which is worse than one that
    // has expired. Treat it as expired rather than as valid forever.
    if (exp === null || exp + CLOCK_SKEW_MS <= now) return reject("expired");

    const notBefore = numeric(payload["nbf"]) ?? numeric(payload["iat"]);
    if (notBefore !== null && notBefore - CLOCK_SKEW_MS > now) return reject("not-yet-valid");

    const subject = payload["sub"];
    if (typeof subject !== "string" || subject.trim() === "") return reject("no-subject");

    // Only the subject leaves this function. `email` and `name` arrive in the
    // token and are dropped here so nothing downstream can log them.
    return { kind: "identified", identity: { subject: subject.trim() } };
  }

  /**
   * Cached key lookup, refetching on an unknown id no more than the cooldown
   * allows.
   *
   * `now` is passed in rather than read, like every other time value here, so
   * cache behaviour is testable and so a single request cannot see two
   * different clocks.
   */
  private async keyFor(kid: string, now: number): Promise<OkpKey | null> {
    const cached = this.keys.get(kid);
    if (cached !== undefined) {
      // Held keys keep working past the TTL; the TTL only prompts a look for
      // changes, and a failed look must not invalidate what we have.
      if (now - this.fetchedAt >= JWKS_TTL_MS) await this.refresh(now, JWKS_TTL_MS);
      const refreshed = this.keys.get(kid);
      return refreshed ?? cached;
    }
    await this.refresh(now, JWKS_MISS_COOLDOWN_MS);
    return this.keys.get(kid) ?? null;
  }

  private async refresh(now: number, floor: number): Promise<void> {
    // Concurrent requests share one outbound call rather than each issuing one.
    if (this.inFlight !== null) return await this.inFlight;
    // The floor is on the *attempt*, unconditionally. An earlier version
    // exempted an empty cache, reasoning that a verifier holding no keys should
    // always try to get some. That exemption was the whole hole: a cold isolate,
    // or any provider that is unreachable or serving a document with no usable
    // key, never populates the cache, so every forged token got its own outbound
    // fetch. `fetchedAt` starts at zero, so the first attempt still goes out
    // immediately; only a *failed* attempt now costs the next caller a wait.
    if (now - this.fetchedAt < floor) return;

    const attempt = this.fetchKeys(now);
    this.inFlight = attempt;
    try {
      await attempt;
    } finally {
      this.inFlight = null;
    }
  }

  private async fetchKeys(now: number): Promise<void> {
    if (this.jwksUrl === null) return;
    // Recorded before the request, so a hanging or failing provider still
    // rate limits the next attempt.
    this.fetchedAt = now;

    let document: unknown;
    try {
      const response = await this.fetchImpl(this.jwksUrl, {
        headers: { Accept: "application/json" },
        redirect: "manual",
      });
      if (!response.ok) return;
      document = await response.json();
    } catch {
      // Keep serving the keys we already have. A provider blip must not
      // invalidate sessions that were signed by a key we already hold.
      return;
    }

    const imported = await importJwks(document);
    // Replace wholesale rather than merging, so a key the provider has
    // withdrawn stops being accepted here too.
    if (imported.size > 0) this.keys = imported;
  }
}

function reject(reason: RejectionReason): SessionOutcome {
  return { kind: "rejected", reason };
}

async function importJwks(document: unknown): Promise<Map<string, OkpKey>> {
  const keys = new Map<string, OkpKey>();
  const parsed = plainObject(document);
  if (parsed === null) return keys;
  const list = parsed["keys"];
  if (!Array.isArray(list)) return keys;

  for (const entry of list) {
    const jwk = plainObject(entry);
    if (jwk === null) continue;
    // Only Ed25519 verification keys. An RSA or EC key in this document is not
    // an error to report, it is simply not something we will verify with.
    if (jwk["kty"] !== "OKP" || jwk["crv"] !== CURVE) continue;
    const kid = jwk["kid"];
    const x = jwk["x"];
    if (typeof kid !== "string" || kid === "" || typeof x !== "string") continue;

    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "OKP", crv: ALGORITHM, x, ext: true },
        { name: ALGORITHM },
        false,
        ["verify"],
      );
      keys.set(kid, { kid, key });
    } catch {
      // A key we cannot import is a key we cannot verify with. Skipping it
      // beats failing the whole document and losing the keys that are fine.
      continue;
    }
  }
  return keys;
}

/**
 * Narrows untrusted JSON to a readable record, by copying rather than asserting.
 *
 * An inline cast would claim a shape without checking one, and every value in
 * this file arrives from the network. The copy is two small objects per
 * verification, which is a fair price for the reads below being genuinely
 * checked.
 */
function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
}

function bearerToken(authorization: string | null): string | null {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
}

/** JWT numeric dates are seconds. Everything else here is milliseconds. */
function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;
}

/** `aud` is a string or an array of them, per the JWT specification. */
function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((entry) => entry === expected);
  return false;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(segment);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return plainObject(parsed);
  } catch {
    return null;
  }
}

function decodeBase64Url(segment: string): Uint8Array<ArrayBuffer> | null {
  // `atob` accepts base64url in this runtime, but relying on that would make
  // correctness depend on an undocumented leniency. Convert explicitly.
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const full = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(full)) return null;
  try {
    const binary = atob(full);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

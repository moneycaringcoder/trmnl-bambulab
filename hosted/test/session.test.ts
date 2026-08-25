/**
 * Session verification, tested against real Ed25519 signatures.
 *
 * Every token here is minted by generating a real key pair, building the two
 * base64url segments, and signing them with Web Crypto. A fake verifier that
 * returned `true` would pass a test built on stub signatures; it cannot pass
 * these. The forgery tests are the point of the file, so they are written as
 * attacks rather than as coverage.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  JWKS_MISS_COOLDOWN_MS,
  JWKS_TTL_MS,
  SessionVerifier,
  type RejectionReason,
  type SessionOutcome,
} from "../src/session.ts";

const BASE = "https://ep-example.aws.neon.tech/neondb/auth";
/** Both `iss` and `aud`: the origin of the base URL, never its full path. */
const ORIGIN = "https://ep-example.aws.neon.tech";
const JWKS_URL = `${BASE}/.well-known/jwks.json`;
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
/**
 * Built at runtime rather than pasted.
 *
 * A bare UUID literal in this repository is a blocker: a TRMNL webhook URL ends
 * in one, so the secret gate cannot tell a harmless example apart from a real
 * credential and is right not to try. Generating one keeps the shape realistic
 * without putting a UUID-shaped literal in the tree.
 */
const SUBJECT = crypto.randomUUID();

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeSegment(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

interface Signer {
  kid: string;
  jwk: Record<string, unknown>;
  sign(header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string>;
}

/** A real Ed25519 key pair, exported as the JWK a provider would publish. */
async function newSigner(kid: string): Promise<Signer> {
  // `generateKey` is typed as returning a key or a pair; an Ed25519 generation
  // always yields a pair, and the union is not narrowable from the arguments.
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

  return {
    kid,
    jwk: { kty: "OKP", crv: "Ed25519", x: publicJwk.x, kid, alg: "EdDSA", use: "sig" },
    async sign(header, payload) {
      const signing = `${encodeSegment(header)}.${encodeSegment(payload)}`;
      const signature = await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(signing),
      );
      return `${signing}.${base64Url(signature)}`;
    },
  };
}

/** The claim set Neon documents, minus the identity fields we refuse to carry. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ORIGIN,
    aud: ORIGIN,
    sub: SUBJECT,
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 900,
    ...overrides,
  };
}

interface Jwks {
  fetchImpl: typeof fetch;
  calls: string[];
  serve(keys: Record<string, unknown>[]): void;
  fail(status: number): void;
}

function jwksServer(initial: Record<string, unknown>[]): Jwks {
  let body: Record<string, unknown>[] = initial;
  let status = 200;
  const calls: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (status !== 200) return new Response("no", { status });
    return Response.json({ keys: body });
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    serve(keys) {
      body = keys;
      status = 200;
    },
    fail(code) {
      status = code;
    },
  };
}

function expectRejected(outcome: SessionOutcome): RejectionReason {
  if (outcome.kind !== "rejected") {
    throw new Error(`expected a rejection, got "${outcome.kind}"`);
  }
  return outcome.reason;
}

let signer: Signer;
let other: Signer;

beforeEach(async () => {
  signer = await newSigner("k-current");
  other = await newSigner("k-attacker");
});

describe("a genuine token", () => {
  it("identifies its subject", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid, typ: "JWT" }, claims());

    const outcome = await verifier.identify(`Bearer ${token}`, NOW);

    expect(outcome).toEqual({ kind: "identified", identity: { subject: SUBJECT } });
    expect(jwks.calls).toEqual([JWKS_URL]);
  });

  // The provider's token also carries `email` and `name`. `AGENTS.md` forbids
  // logging an email, and the way to honour that reliably is to never hand one
  // to a caller that might.
  it("discards every claim except the subject, so an email cannot leak", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign(
      { alg: "EdDSA", kid: signer.kid },
      claims({ email: "someone@example.com", name: "Someone Real" }),
    );

    const outcome = await verifier.identify(`Bearer ${token}`, NOW);

    if (outcome.kind !== "identified") throw new Error("a genuine token was rejected");
    expect(Object.keys(outcome.identity)).toEqual(["subject"]);
    expect(JSON.stringify(outcome)).not.toContain("example.com");
    expect(JSON.stringify(outcome)).not.toContain("Someone Real");
  });

  it("accepts an audience array containing the origin", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign(
      { alg: "EdDSA", kid: signer.kid },
      claims({ aud: ["https://elsewhere.example", ORIGIN] }),
    );

    expect((await verifier.identify(`Bearer ${token}`, NOW)).kind).toBe("identified");
  });

  it("reads the scheme case-insensitively and tolerates spacing", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());

    for (const header of [`bearer ${token}`, `BEARER  ${token}`, ` Bearer ${token} `]) {
      expect((await verifier.identify(header, NOW)).kind).toBe("identified");
    }
  });
});

describe("forgeries", () => {
  it("refuses a token signed by a key the provider does not publish", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    // Signed with a real key, correctly, but not one the provider vouches for.
    const token = await other.sign({ alg: "EdDSA", kid: other.kid }, claims());

    expect(expectRejected(await verifier.identify(`Bearer ${token}`, NOW))).toBe("unknown-key");
  });

  // The attacker publishes their own key id but claims a trusted one, hoping the
  // verifier trusts the header's `kid` more than the signature.
  it("refuses a genuine signature presented under a trusted key id", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await other.sign({ alg: "EdDSA", kid: signer.kid }, claims());

    expect(expectRejected(await verifier.identify(`Bearer ${token}`, NOW))).toBe("bad-signature");
  });

  it("refuses an unsigned token claiming the algorithm is none", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const forged = `${encodeSegment({ alg: "none", kid: signer.kid })}.${encodeSegment(claims())}.`;

    expect(expectRejected(await verifier.identify(`Bearer ${forged}`, NOW))).toBe(
      "wrong-algorithm",
    );
    // Nothing was fetched, because the algorithm is refused before any key is
    // touched. A verifier that reached for a key here would be doing work an
    // anonymous caller can command.
    expect(jwks.calls).toEqual([]);
  });

  it("refuses an HMAC token even when the secret is the published key", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const header = { alg: "HS256", kid: signer.kid };
    const signing = `${encodeSegment(header)}.${encodeSegment(claims())}`;
    const hmacKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(String(signer.jwk["x"])),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(signing));

    const outcome = await verifier.identify(`Bearer ${signing}.${base64Url(mac)}`, NOW);

    expect(expectRejected(outcome)).toBe("wrong-algorithm");
  });

  it("refuses a token whose payload was edited after signing", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());
    const [header, , signature] = token.split(".");
    const swapped = `${header}.${encodeSegment(claims({ sub: "someone-else" }))}.${signature}`;

    expect(expectRejected(await verifier.identify(`Bearer ${swapped}`, NOW))).toBe("bad-signature");
  });


  it("refuses a signature of the wrong length", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());
    const [header, payload] = token.split(".");

    for (const forged of ["AAAA", "", "A".repeat(200), base64Url(new Uint8Array(63))]) {
      const outcome = await verifier.identify(`Bearer ${header}.${payload}.${forged}`, NOW);
      // Either reason is correct: a segment that is not base64url at all is
      // malformed, and one that decodes to the wrong number of bytes is a bad
      // signature. What matters is that both are refusals.
      expect(["bad-signature", "malformed"]).toContain(expectRejected(outcome));
    }
  });

  // The regression this actually guards, and it has to be written this way.
  //
  // The bug was found by pointing the Worker at the real provider: Ed25519
  // wants exactly 64 bytes, and *workerd* throws on any other length while Node
  // returns false. Vitest runs under Node here, so the test above passes with
  // the fix reverted — it pins the refusal contract, not the regression. Forcing
  // the throw is the only way to exercise the catch in this runner, and it is
  // worth doing precisely because the runtime that throws is the one we ship to.
  it("refuses rather than propagating when verify throws", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());

    const real = crypto.subtle.verify;
    crypto.subtle.verify = () => {
      throw new Error("OperationError");
    };
    try {
      const outcome = await verifier.identify(`Bearer ${token}`, NOW);
      // Unwrapped, this throw escaped to the route's outer catch and became a
      // 503: our fault rather than the caller's, and a signal that a signature
      // was malformed rather than merely wrong.
      expect(expectRejected(outcome)).toBe("bad-signature");
    } finally {
      crypto.subtle.verify = real;
    }
  });

  it("does not treat a thrown verify as a success", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());

    const real = crypto.subtle.verify;
    crypto.subtle.verify = () => Promise.reject(new Error("OperationError"));
    try {
      // A rejected promise, not a synchronous throw: the other shape the same
      // runtime can produce.
      const outcome = await verifier.identify(`Bearer ${token}`, NOW);
      expect(outcome.kind).not.toBe("identified");
    } finally {
      crypto.subtle.verify = real;
    }
  });

  it("refuses tokens from another issuer signing with a key we trust", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });

    for (const bad of [
      claims({ iss: "https://attacker.example" }),
      claims({ aud: "https://attacker.example" }),
      // A path-suffixed issuer is not the origin, and must not be accepted just
      // because it starts with one.
      claims({ iss: `${ORIGIN}/neondb/auth` }),
    ]) {
      const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, bad);
      expect(expectRejected(await verifier.identify(`Bearer ${token}`, NOW))).toBe("wrong-issuer");
    }
  });

  it("refuses shapes that are not tokens at all", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });

    for (const junk of ["a.b", "a.b.c.d", "!!!.###.$$$", "...."]) {
      expect(expectRejected(await verifier.identify(`Bearer ${junk}`, NOW))).toBe("malformed");
    }
  });
});

describe("time", () => {
  it("refuses an expired token, and allows only a small skew", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());
    const expiry = NOW + 900_000;

    expect((await verifier.identify(`Bearer ${token}`, expiry - 1_000)).kind).toBe("identified");
    // Inside the skew allowance, still accepted.
    expect((await verifier.identify(`Bearer ${token}`, expiry + 20_000)).kind).toBe("identified");
    // Past it, refused. A generous skew would extend a token's life past a
    // revocation, which is why the allowance is seconds and not minutes.
    expect(expectRejected(await verifier.identify(`Bearer ${token}`, expiry + 60_000))).toBe(
      "expired",
    );
  });

  // A token with no expiry never dies, which is worse than one that has died.
  it("treats a missing expiry as expired rather than as eternal", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const withoutExp = claims();
    delete withoutExp["exp"];
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, withoutExp);

    expect(expectRejected(await verifier.identify(`Bearer ${token}`, NOW))).toBe("expired");
  });

  it("refuses a token minted for the future", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign(
      { alg: "EdDSA", kid: signer.kid },
      claims({ iat: Math.floor(NOW / 1000) + 3600, exp: Math.floor(NOW / 1000) + 4500 }),
    );

    expect(expectRejected(await verifier.identify(`Bearer ${token}`, NOW))).toBe("not-yet-valid");
  });
});

describe("key handling", () => {
  // The cooldown is the compromise: rotation must be picked up quickly without
  // an unknown key id becoming a way to command an outbound request. Both
  // halves are asserted, because a change that fixed one by breaking the other
  // would otherwise look like a pass.
  it("does not refetch for an unknown id inside the cooldown", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    await verifier.identify(
      `Bearer ${await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims())}`,
      NOW,
    );

    const rotated = await newSigner("k-rotated");
    jwks.serve([rotated.jwk]);
    const token = await rotated.sign({ alg: "EdDSA", kid: rotated.kid }, claims());

    const tooSoon = await verifier.identify(
      `Bearer ${token}`,
      NOW + JWKS_MISS_COOLDOWN_MS - 1,
    );

    expect(expectRejected(tooSoon)).toBe("unknown-key");
    expect(jwks.calls.length).toBe(1);
  });

  it("picks up a rotated key once the cooldown has passed", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    await verifier.identify(
      `Bearer ${await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims())}`,
      NOW,
    );

    const rotated = await newSigner("k-rotated");
    jwks.serve([rotated.jwk]);
    const token = await rotated.sign({ alg: "EdDSA", kid: rotated.kid }, claims());

    // Well inside the five-minute staleness TTL: an unknown key id is the
    // documented signal that a rotation happened, so waiting for the TTL would
    // reject valid sessions for minutes.
    const outcome = await verifier.identify(`Bearer ${token}`, NOW + JWKS_MISS_COOLDOWN_MS);

    expect(outcome.kind).toBe("identified");
    expect(jwks.calls.length).toBe(2);
  });

  it("stops accepting a key the provider has withdrawn", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const retired = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());
    expect((await verifier.identify(`Bearer ${retired}`, NOW)).kind).toBe("identified");

    const rotated = await newSigner("k-rotated");
    jwks.serve([rotated.jwk]);
    // Force the refetch by presenting the new id, which replaces the key set.
    const later = NOW + JWKS_MISS_COOLDOWN_MS;
    await verifier.identify(
      `Bearer ${await rotated.sign({ alg: "EdDSA", kid: rotated.kid }, claims())}`,
      later,
    );

    expect(expectRejected(await verifier.identify(`Bearer ${retired}`, later))).toBe("unknown-key");
  });

  // A held key must keep working past the staleness TTL. Treating the TTL as an
  // expiry would reject every live session whenever the provider was briefly
  // unreachable.
  it("keeps a held key working past the staleness TTL", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign(
      { alg: "EdDSA", kid: signer.kid },
      claims({ exp: Math.floor(NOW / 1000) + 86_400 }),
    );
    expect((await verifier.identify(`Bearer ${token}`, NOW)).kind).toBe("identified");

    jwks.fail(500);
    const outcome = await verifier.identify(`Bearer ${token}`, NOW + JWKS_TTL_MS + 1);

    expect(outcome.kind).toBe("identified");
    // It did look for changes, and failing to find them changed nothing.
    expect(jwks.calls.length).toBe(2);
  });

  // The hole an audit found by measuring rather than reading: an earlier version
  // exempted an empty key cache from the refetch floor, so a provider that never
  // yields a usable key turned every forged token into its own outbound request.
  // Twenty sequential attempts, one instant, one fetch.
  it("does not fetch once per token when the provider never yields a key", async () => {
    const jwks = jwksServer([signer.jwk]);
    jwks.fail(503);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const token = await other.sign({ alg: "EdDSA", kid: `forged-${attempt}` }, claims());
      expect(expectRejected(await verifier.identify(`Bearer ${token}`, NOW))).toBe("unknown-key");
    }

    expect(jwks.calls.length).toBe(1);
  });

  it("still tries immediately on a cold verifier", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());

    // The floor must not delay the very first fetch, or a fresh isolate would
    // refuse every session for its first thirty seconds.
    expect((await verifier.identify(`Bearer ${token}`, NOW)).kind).toBe("identified");
    expect(jwks.calls.length).toBe(1);
  });

  it("recovers once the floor has passed and the provider is back", async () => {
    const jwks = jwksServer([signer.jwk]);
    jwks.fail(503);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());
    expect(expectRejected(await verifier.identify(`Bearer ${token}`, NOW))).toBe("unknown-key");

    jwks.serve([signer.jwk]);

    // Still inside the floor: refused, and no second request.
    expect(
      expectRejected(await verifier.identify(`Bearer ${token}`, NOW + JWKS_MISS_COOLDOWN_MS - 1)),
    ).toBe("unknown-key");
    expect(jwks.calls.length).toBe(1);

    // Past it: one more request, and the session works.
    expect((await verifier.identify(`Bearer ${token}`, NOW + JWKS_MISS_COOLDOWN_MS)).kind).toBe(
      "identified",
    );
    expect(jwks.calls.length).toBe(2);
  });

  // Without a floor on refetching, anyone can turn one forged token into one
  // outbound request, and a flood of them into a flood of requests.
  it("does not fetch once per forged key id", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const token = await other.sign({ alg: "EdDSA", kid: `forged-${attempt}` }, claims());
      expect(expectRejected(await verifier.identify(`Bearer ${token}`, NOW))).toBe("unknown-key");
    }

    // One fetch to populate, and none after: the TTL floor holds.
    expect(jwks.calls.length).toBe(1);
  });

  it("keeps serving known keys when the provider is failing", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());
    expect((await verifier.identify(`Bearer ${token}`, NOW)).kind).toBe("identified");

    jwks.fail(503);

    // A provider outage must not invalidate sessions signed by a key we hold.
    expect((await verifier.identify(`Bearer ${token}`, NOW)).kind).toBe("identified");
  });

  it("ignores key types it cannot verify with", async () => {
    const jwks = jwksServer([
      { kty: "RSA", n: "nope", e: "AQAB", kid: signer.kid },
      { kty: "OKP", crv: "X25519", x: "nope", kid: "x25519" },
      signer.jwk,
    ]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());

    // The Ed25519 key still loads despite the company it keeps, and the RSA
    // entry sharing its id does not shadow it.
    expect((await verifier.identify(`Bearer ${token}`, NOW)).kind).toBe("identified");
  });
});

describe("configuration", () => {

  // The Worker builds the verifier before the try that catches configuration
  // failures, so a throw here escaped as a platform 500 rather than the
  // deliberate 503 every other misconfiguration produces.
  it("treats an unusable base URL as unconfigured rather than throwing", async () => {
    const jwks = jwksServer([signer.jwk]);
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());

    for (const baseUrl of [
      "not a url",
      "://missing-scheme",
      "ep-host.example/db/auth",
      // Parses, but is not something we may fetch a key set from.
      "file:///etc/passwd",
      "data:text/plain,hello",
      "javascript:alert(1)",
    ]) {
      const verifier = new SessionVerifier({ baseUrl, fetchImpl: jwks.fetchImpl });
      expect(verifier.configured).toBe(false);
      expect((await verifier.identify(`Bearer ${token}`, NOW)).kind).toBe("unconfigured");
    }
    expect(jwks.calls).toEqual([]);
  });

  it("refuses every request when identity is not provisioned", async () => {
    const jwks = jwksServer([signer.jwk]);
    const token = await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims());

    for (const baseUrl of [undefined, "", "   "]) {
      const verifier = new SessionVerifier({ baseUrl, fetchImpl: jwks.fetchImpl });
      expect(verifier.configured).toBe(false);
      // Unconfigured, not anonymous and not identified: a deployment without an
      // identity provider must refuse rather than trust the caller.
      expect((await verifier.identify(`Bearer ${token}`, NOW)).kind).toBe("unconfigured");
      expect((await verifier.identify(null, NOW)).kind).toBe("unconfigured");
    }
    expect(jwks.calls).toEqual([]);
  });

  it("separates presenting nothing from presenting a forgery", async () => {
    const jwks = jwksServer([signer.jwk]);
    const verifier = new SessionVerifier({ baseUrl: BASE, fetchImpl: jwks.fetchImpl });

    for (const header of [null, "", "Basic abc", "Bearer", "Bearer   "]) {
      expect((await verifier.identify(header, NOW)).kind).toBe("anonymous");
    }
    expect(jwks.calls).toEqual([]);
  });

  it("reads the JWKS from the base path and the issuer from the origin", async () => {
    const jwks = jwksServer([signer.jwk]);
    for (const base of [BASE, `${BASE}/`, `${BASE}//`]) {
      const verifier = new SessionVerifier({ baseUrl: base, fetchImpl: jwks.fetchImpl });
      await verifier.identify(
        `Bearer ${await signer.sign({ alg: "EdDSA", kid: signer.kid }, claims())}`,
        NOW,
      );
    }
    // The key set lives under the full base path; the issuer is the bare origin.
    // Conflating the two is the mistake this pins.
    expect(new Set(jwks.calls)).toEqual(new Set([JWKS_URL]));
  });
});

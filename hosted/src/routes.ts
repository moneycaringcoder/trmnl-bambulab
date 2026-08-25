/**
 * The authenticated surface: sign in, pick printers, rotate a key, delete.
 *
 * Separate from `worker.ts` so every route is testable without a Worker, and
 * separate from `enrol.ts` so the Bambu conversation stays independent of who is
 * asking. This module is the only place the two meet.
 *
 * The rules every route here follows:
 *
 * **No identity, no route.** Each one resolves a session first and refuses
 * before touching an account. When identity is not provisioned the whole surface
 * answers 404 rather than falling back to trusting the caller, so a half-
 * configured deployment exposes nothing rather than exposing everything.
 *
 * **One person, one account.** The owner tag is unique, so signing in twice
 * updates an account instead of accumulating them.
 *
 * **Nothing is logged.** Not an email, not a device id, not an account id, not a
 * token, and not the text of a cloud error. `AGENTS.md` requires that, and this
 * surface is where an email first enters the system, so it is the file most
 * likely to break it.
 *
 * **A cloud token never leaves.** It is sealed on arrival and the sealed form is
 * all that is stored. No response body here contains one, and no response body
 * contains a screen key except the single one that issues it.
 */

import { newAccountId, newScreenKey, ownerTagCandidates, screenKeyFingerprint, sealToken, type Keyring } from "./crypto.ts";
import { chooseFrom, type DiscoveredPrinter, type EnrolFailure } from "./enrol.ts";
import type { RateLimiter } from "./screen.ts";
import type { SessionVerifier } from "./session.ts";
import type { Account, Region, Store } from "./store.ts";

/**
 * The ceiling on printers per account.
 *
 * Three because that is what the display can carry legibly at 800x480 in one
 * bit, which is a rendering fact rather than a storage one. See `src/`.
 */
export const MAX_PRINTERS = 3;

/** Defaults a new account gets. Neither is user-supplied. */
const DEFAULT_MAX_PAYLOAD_BYTES = 2048;

export interface EnrolPorts {
  store: Store;
  keyring: Keyring;
  verifier: SessionVerifier;
  /**
   * Bounds what one signed-in person can do, keyed by their owner tag.
   *
   * Required, not optional. It was optional so tests could omit it, and that
   * made the fail-closed guarantee below depend on configuration: dropping the
   * binding from `wrangler.jsonc` would silently remove the only bound on making
   * Bambu email arbitrary addresses. That is the same class of mistake as the
   * fault this guarantee exists to prevent, arriving by a different route, so
   * the type now refuses it and tests supply a permissive one explicitly.
   */
  limiter: RateLimiter;
  /** Injected so a test never reaches Bambu, and never reads a clock. */
  requestSignInCode(region: Region, email: string): Promise<CodeOutcome>;
  completeSignIn(region: Region, email: string, code: string): Promise<SignInOutcome>;
  /**
   * Re-lists the printers on a stored account, for validating a selection.
   *
   * A port rather than a parameter, because the alternative is to trust the
   * browser's own list of what is available, and a browser is exactly the thing
   * whose claims this check exists to test. The Worker supplies this by opening
   * the sealed token and asking Bambu.
   */
  printersFor(account: Account): Promise<DiscoveredPrinter[]>;
  now: number;
}

export type CodeOutcome = { ok: true } | { ok: false; failure: EnrolFailure };
export type SignInOutcome =
  | { ok: true; accessToken: string; printers: DiscoveredPrinter[] }
  | { ok: false; failure: EnrolFailure };

/**
 * What a route decided, before it becomes HTTP.
 *
 * A discriminated result rather than a `Response` so the tests assert on
 * decisions and the status mapping lives in exactly one place.
 */
export type RouteResult =
  /** Success with nothing to say. */
  | { kind: "done" }
  | { kind: "printers"; printers: PublicPrinter[] }
  /** The one response that ever carries a screen key. */
  | { kind: "key-issued"; screenKey: string }
  | { kind: "account"; deviceIds: string[]; reauthRequired: boolean }
  /** No session, or identity is not configured. Indistinguishable outside. */
  | { kind: "unauthenticated" }
  | { kind: "no-account" }
  | { kind: "throttled" }
  | { kind: "invalid"; guidance: string }
  | { kind: "upstream"; failure: EnrolFailure };

/**
 * A printer as the picker sees it.
 *
 * The device id is here because the browser has to name its choice back to us,
 * and the person choosing already knows their own printers' serials. It must
 * still never be logged, and it never reaches TRMNL.
 */
export interface PublicPrinter {
  deviceId: string;
  name: string;
  online: boolean;
  model: string | null;
}

/** Region is not free text: an unknown value would point us at a wrong host. */
function parseRegion(value: unknown): Region | null {
  return value === "global" || value === "china" ? value : null;
}

function parseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  // Deliberately minimal. Bambu is the authority on whether an address exists,
  // and a clever local regex would only reject addresses that actually work.
  if (email.length < 3 || email.length > 254 || !email.includes("@")) return null;
  return email;
}

function parseCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return /^[0-9]{4,10}$/.test(code) ? code : null;
}

async function identify(
  ports: EnrolPorts,
  authorization: string | null,
): Promise<{ ok: true; account: Account | null; tags: string[] } | { ok: false }> {
  const outcome = await ports.verifier.identify(authorization, ports.now);
  if (outcome.kind !== "identified") return { ok: false };

  const tags = await ownerTagCandidates(ports.keyring, outcome.identity.subject);
  return { ok: true, account: await ports.store.accountByOwner(tags), tags };
}

/**
 * Asks the enrolment limiter for permission, and refuses when it cannot answer.
 *
 * This is the opposite of the screen endpoint's choice, deliberately. There, a
 * limiter fault costs only our own database work, so failing closed would turn
 * an abuse control into an outage for every display. Here the limiter is the
 * only bound on how often `POST /v1/enrol/code` can make Bambu email an
 * address, which is the open-relay risk it exists to close, and a fault would
 * remove that bound entirely.
 *
 * The blast radius of failing closed is small: new enrolment stops until the
 * limiter recovers, and every display already configured keeps working, because
 * the screen endpoint is a different route with a different limiter. Choosing
 * our own inconvenience over sending mail to other people is not a close call.
 */
async function permitted(ports: EnrolPorts, tag: string): Promise<boolean> {
  try {
    return (await ports.limiter.limit({ key: tag })).success;
  } catch {
    return false;
  }
}

/**
 * Asks Bambu to email a sign-in code.
 *
 * Answers identically whether or not Bambu recognised the address. Whether
 * somebody has a Bambu account is not ours to disclose, and a route that said so
 * would be a way to test addresses against Bambu's user base.
 */
export async function postSignInCode(
  ports: EnrolPorts,
  authorization: string | null,
  body: unknown,
): Promise<RouteResult> {
  const session = await identify(ports, authorization);
  if (!session.ok) return { kind: "unauthenticated" };

  const tag = session.tags[0];
  if (tag === undefined) return { kind: "unauthenticated" };
  if (!(await permitted(ports, tag))) return { kind: "throttled" };

  const fields = plainObject(body);
  const region = parseRegion(fields?.["region"]);
  const email = parseEmail(fields?.["email"]);
  if (region === null) return { kind: "invalid", guidance: "Choose a Bambu Cloud region." };
  if (email === null) {
    return { kind: "invalid", guidance: "Enter the email address of your Bambu account." };
  }

  const outcome = await ports.requestSignInCode(region, email);
  // A refusal from Bambu is reported as success. The route is not lying about
  // its own behaviour: it did ask. What it declines to reveal is Bambu's answer.
  if (!outcome.ok && outcome.failure.kind === "cloud-unavailable") {
    return { kind: "upstream", failure: outcome.failure };
  }
  return { kind: "done" };
}

/**
 * Exchanges the emailed code for a token and lists printers.
 *
 * Creates the account if this identity has none, and replaces the token if it
 * does, which is also how a re-authentication works after a token expires. The
 * account is created with a screen key nobody has been told, because the column
 * cannot be empty and the key the user keeps is the one issued once printers are
 * chosen.
 */
export async function postSession(
  ports: EnrolPorts,
  authorization: string | null,
  body: unknown,
): Promise<RouteResult> {
  const session = await identify(ports, authorization);
  if (!session.ok) return { kind: "unauthenticated" };

  const tag = session.tags[0];
  if (tag === undefined) return { kind: "unauthenticated" };
  if (!(await permitted(ports, tag))) return { kind: "throttled" };

  const fields = plainObject(body);
  const region = parseRegion(fields?.["region"]);
  const email = parseEmail(fields?.["email"]);
  const code = parseCode(fields?.["code"]);
  if (region === null) return { kind: "invalid", guidance: "Choose a Bambu Cloud region." };
  if (email === null) {
    return { kind: "invalid", guidance: "Enter the email address of your Bambu account." };
  }
  if (code === null) {
    return { kind: "invalid", guidance: "Enter the numeric code Bambu emailed you." };
  }

  const existing = session.account;
  // A region mismatch is refused rather than ignored. The region decides which
  // Bambu host the cron talks to, so quietly keeping the old one would leave an
  // account whose token was minted somewhere it will never be presented.
  if (existing !== null && existing.region !== region) {
    return {
      kind: "invalid",
      guidance:
        "This account is already set up for the other Bambu Cloud region. Delete it and " +
        "enrol again to change region.",
    };
  }

  const outcome = await ports.completeSignIn(region, email, code);
  if (!outcome.ok) return { kind: "upstream", failure: outcome.failure };

  const accountId = existing?.id ?? (await createFor(ports, tag, region));
  // Sealed against this account's id, which is what binds the ciphertext to the
  // row: a token lifted into another account's row will not open. `replaceToken`
  // also clears `reauthRequired`, which is exactly right after a fresh sign-in.
  await ports.store.replaceToken(
    accountId,
    await sealToken(ports.keyring, accountId, outcome.accessToken),
  );

  return { kind: "printers", printers: outcome.printers.map(publicPrinter) };
}

/**
 * Records the chosen printers and issues the screen key.
 *
 * The key is minted here rather than at account creation because this is the
 * first moment the account can render anything, and a key handed out before
 * then would point at a display that stays blank.
 */
export async function postPrinters(
  ports: EnrolPorts,
  authorization: string | null,
  body: unknown,
): Promise<RouteResult> {
  const session = await identify(ports, authorization);
  if (!session.ok) return { kind: "unauthenticated" };
  const account = session.account;
  if (account === null) return { kind: "no-account" };

  const fields = plainObject(body);
  const requested = fields?.["deviceIds"];
  if (
    !Array.isArray(requested) ||
    requested.length === 0 ||
    !requested.every((id) => typeof id === "string")
  ) {
    return { kind: "invalid", guidance: "Choose at least one printer." };
  }

  // Metered like the two sign-in routes, because it also reaches Bambu. It
  // cannot make Bambu send mail, so it is a smaller exposure, but an
  // unmetered authenticated path to repeated cloud calls is exactly the loop
  // that `store.ts` warns earns an account a ban. The check sits after the
  // cheap validation above so a malformed request does not spend budget.
  if (!(await permitted(ports, session.tags[0] ?? ""))) return { kind: "throttled" };

  // Asked of Bambu, not read from the request. The browser names its choice and
  // this decides whether that choice exists, which is only meaningful if the
  // two come from different places.
  let available: DiscoveredPrinter[];
  try {
    available = await ports.printersFor(account);
  } catch {
    return {
      kind: "upstream",
      failure: {
        kind: "cloud-unavailable",
        guidance: "Bambu Cloud did not answer. Try again in a few minutes.",
      },
    };
  }

  const chosen = chooseFrom(available, requested, MAX_PRINTERS);
  if (!chosen.ok) {
    return {
      kind: "invalid",
      guidance: "One of those printers is no longer on your Bambu account. Sign in again.",
    };
  }

  await ports.store.replacePrinters(account.id, chosen.deviceIds);
  return await issueKey(ports, account.id);
}

/** Retires the current screen key and issues a replacement. */
export async function postKeyRotation(
  ports: EnrolPorts,
  authorization: string | null,
): Promise<RouteResult> {
  const session = await identify(ports, authorization);
  if (!session.ok) return { kind: "unauthenticated" };
  if (session.account === null) return { kind: "no-account" };
  return await issueKey(ports, session.account.id);
}

/**
 * Deletes the account and everything belonging to it.
 *
 * `AGENTS.md` requires deletion to actually delete, and the store's contract
 * carries that obligation: the row and its rendered screen go, with no tombstone
 * holding a token, a device id, or a fingerprint.
 */
export async function deleteAccount(
  ports: EnrolPorts,
  authorization: string | null,
): Promise<RouteResult> {
  const session = await identify(ports, authorization);
  if (!session.ok) return { kind: "unauthenticated" };
  if (session.account === null) return { kind: "no-account" };

  await ports.store.deleteAccount(session.account.id);
  return { kind: "done" };
}

/** What the settings page shows: the chosen printers and whether to re-auth. */
export async function getAccount(
  ports: EnrolPorts,
  authorization: string | null,
): Promise<RouteResult> {
  const session = await identify(ports, authorization);
  if (!session.ok) return { kind: "unauthenticated" };
  if (session.account === null) return { kind: "no-account" };

  return {
    kind: "account",
    deviceIds: session.account.deviceIds,
    reauthRequired: session.account.reauthRequired,
  };
}

async function issueKey(ports: EnrolPorts, accountId: string): Promise<RouteResult> {
  const screenKey = newScreenKey();
  await ports.store.replaceScreenKey(accountId, await screenKeyFingerprint(screenKey));
  // The only response in this module that carries a key. It is not stored, so
  // this is the one moment it exists anywhere we control.
  return { kind: "key-issued", screenKey };
}

async function createFor(ports: EnrolPorts, ownerTag: string, region: Region): Promise<string> {
  const id = newAccountId();
  const placeholder = newScreenKey();
  await ports.store.createAccount({
    id,
    ownerTag,
    region,
    // Replaced immediately by the caller, which has the real token. A sealed
    // placeholder rather than an empty column, so the column's NOT NULL is a
    // real guarantee rather than one the application works around.
    token: await sealToken(ports.keyring, id, placeholder),
    screenKeyFingerprint: await screenKeyFingerprint(placeholder),
    deviceIds: [],
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    exportJobName: false,
  });
  return id;
}

function publicPrinter(printer: DiscoveredPrinter): PublicPrinter {
  return {
    deviceId: printer.deviceId,
    name: printer.name,
    online: printer.online,
    model: printer.model,
  };
}

/** Narrows an untrusted body by copying, never by asserting a shape. */
function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
}

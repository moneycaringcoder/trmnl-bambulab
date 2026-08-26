/**
 * The authenticated surface: sign in to Bambu, pick printers, delete.
 *
 * Separate from `worker.ts` so every route is testable without a Worker, and
 * separate from `enrol.ts` so the Bambu conversation stays independent of who is
 * asking. This module is the only place the two meet.
 *
 * Identity is a TRMNL installation. The install handshake minted a management
 * token (see `trmnl.ts`), the setup page presents it as a Bearer token, and
 * every route resolves it before touching an account. There is no sign-up and
 * no password: TRMNL is the account system, and Bambu sign-in below is the
 * printer credential, not an identity.
 *
 * The rules every route here follows:
 *
 * **No identity, no route.** Refuse before touching an account.
 *
 * **One installation, one account.** The owner tag is unique and derived from
 * the installation id, so signing in twice updates an account instead of
 * accumulating them.
 *
 * **Nothing is logged.** Not an email, not a device id, not an account id, not a
 * token, and not the text of a cloud error. `AGENTS.md` requires that, and this
 * surface is where an email first enters the system, so it is the file most
 * likely to break it.
 *
 * **A cloud token never leaves.** It is sealed on arrival and the sealed form is
 * all that is stored. No response body here contains one.
 */

import { newAccountId, sealToken, type Keyring } from "@trmnl-bambulab/core/hosted/crypto";
import {
  chooseFrom,
  type DiscoveredPrinter,
  type EnrolFailure,
  type PrinterListResult,
} from "./enrol.ts";
import type { RateLimiter } from "./limits.ts";
import { installationOwnerTags, verifyManageToken } from "./trmnl.ts";
import type {
  Account,
  Installation,
  Region,
  Store,
} from "@trmnl-bambulab/core/hosted/store";

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
  /**
   * Bounds what one installation can do, keyed by its owner tag.
   *
   * Required, not optional. It was optional so tests could omit it, and that
   * made the fail-closed guarantee below depend on configuration: dropping the
   * binding from `wrangler.jsonc` would silently remove the only bound on making
   * Bambu email arbitrary addresses. The type refuses that, and tests supply a
   * permissive limiter explicitly.
   */
  limiter: RateLimiter;
  /** Injected so a test never reaches Bambu, and never reads a clock. */
  requestSignInCode(region: Region, email: string): Promise<CodeOutcome>;
  completeSignIn(region: Region, email: string, code: string): Promise<SignInOutcome>;
  /**
   * Re-lists the printers on a stored account through its sealed cloud token.
   *
   * A result distinguishes a refused token from a temporary outage, because
   * the browser must ask for a fresh code only for the former.
   */
  printersFor(account: Account): Promise<PrinterListResult>;
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
  | { kind: "account"; deviceIds: string[]; reauthRequired: boolean }
  | { kind: "reauth-required"; guidance: string }
  /** No installation, or the token expired. Indistinguishable outside. */
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

/**
 * Resolves the installation a management token speaks for, and its account.
 *
 * `null` for a missing, malformed, expired or forged token — one answer for all
 * four, so the route is not an oracle for guessing tokens. The account is
 * resolved through the installation's own link first and the owner tag second,
 * which keeps an account reachable across the moment the link is being written.
 */
async function identify(
  ports: EnrolPorts,
  authorization: string | null,
): Promise<{ installation: Installation; account: Account | null; tags: string[] } | null> {
  const match = /^bearer\s+(\S+)$/i.exec((authorization ?? "").trim());
  const token = match?.[1];
  if (token === undefined) return null;

  const installation = await verifyManageToken(ports.keyring, ports.store, token, ports.now);
  if (installation === null) return null;

  const tags = await installationOwnerTags(ports.keyring, installation.id);
  const account =
    installation.accountId !== null
      ? await ports.store.accountById(installation.accountId)
      : await ports.store.accountByOwner(tags);
  return { installation, account, tags };
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
  if (session === null) return { kind: "unauthenticated" };

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
 * does, which is also how re-authentication works after a token expires. A new
 * account receives a sealed placeholder only to satisfy the storage invariant;
 * the successful cloud token replaces it before this route returns.
 */
export async function postSession(
  ports: EnrolPorts,
  authorization: string | null,
  body: unknown,
): Promise<RouteResult> {
  const session = await identify(ports, authorization);
  if (session === null) return { kind: "unauthenticated" };

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
 * Records the chosen printers and binds the account to the installation.
 *
 * The link is made here rather than at account creation because this is the
 * first moment the account can render anything: TRMNL's markup requests start
 * resolving to a real screen exactly when there is a screen to resolve to.
 */
export async function postPrinters(
  ports: EnrolPorts,
  authorization: string | null,
  body: unknown,
): Promise<RouteResult> {
  const session = await identify(ports, authorization);
  if (session === null) return { kind: "unauthenticated" };
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
  const listed = await listForAccount(ports, account);
  if (!listed.ok) return listed.result;
  const available = listed.printers;

  const chosen = chooseFrom(available, requested, MAX_PRINTERS);
  if (!chosen.ok) {
    return {
      kind: "invalid",
      guidance:
        chosen.kind === "too-many"
          ? `Choose no more than ${chosen.maxPrinters} printers.`
          : "One of those printers is no longer on your Bambu account. " +
            "Review the list and choose again.",
    };
  }

  await ports.store.replacePrinters(account.id, chosen.deviceIds);
  await ports.store.linkInstallationAccount(session.installation.id, account.id);
  return { kind: "done" };
}

/** Lists the printers visible through the saved cloud token. */
export async function getPrinters(
  ports: EnrolPorts,
  authorization: string | null,
): Promise<RouteResult> {
  const session = await identify(ports, authorization);
  if (session === null) return { kind: "unauthenticated" };
  if (session.account === null) return { kind: "no-account" };
  if (!(await permitted(ports, session.tags[0] ?? ""))) return { kind: "throttled" };

  const listed = await listForAccount(ports, session.account);
  if (!listed.ok) return listed.result;
  return { kind: "printers", printers: listed.printers.map(publicPrinter) };
}

async function listForAccount(
  ports: EnrolPorts,
  account: Account,
): Promise<
  | { ok: true; printers: DiscoveredPrinter[] }
  | { ok: false; result: RouteResult }
> {
  let outcome: PrinterListResult;
  try {
    outcome = await ports.printersFor(account);
  } catch {
    return {
      ok: false,
      result: {
        kind: "upstream",
        failure: {
          kind: "cloud-unavailable",
          guidance: "Bambu Cloud did not answer. Try again in a few minutes.",
        },
      },
    };
  }
  if (outcome.ok) return { ok: true, printers: outcome.printers };
  if (outcome.failure.kind === "refused") {
    await ports.store.markReauthRequired(account.id);
    return {
      ok: false,
      result: {
        kind: "reauth-required",
        guidance: "Your saved Bambu sign-in expired. Sign in again.",
      },
    };
  }
  return { ok: false, result: { kind: "upstream", failure: outcome.failure } };
}

/**
 * Deletes the account and everything belonging to it.
 *
 * `AGENTS.md` requires deletion to actually delete, and the store's contract
 * carries that obligation: the row and its rendered screen go, with no tombstone
 * holding a token or a device id. The installation row survives — TRMNL still
 * has this plugin installed — and can enrol a fresh Bambu account.
 */
export async function deleteAccount(
  ports: EnrolPorts,
  authorization: string | null,
): Promise<RouteResult> {
  const session = await identify(ports, authorization);
  if (session === null) return { kind: "unauthenticated" };
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
  if (session === null) return { kind: "unauthenticated" };
  if (session.account === null) return { kind: "no-account" };

  return {
    kind: "account",
    deviceIds: session.account.deviceIds,
    reauthRequired: session.account.reauthRequired,
  };
}

async function createFor(ports: EnrolPorts, ownerTag: string, region: Region): Promise<string> {
  const id = newAccountId();
  // Sealed placeholder rather than an empty column, so the token columns'
  // NOT NULL is a real guarantee. Replaced immediately by the caller, which
  // has the real token.
  const placeholder = crypto.randomUUID();
  await ports.store.createAccount({
    id,
    ownerTag,
    region,
    token: await sealToken(ports.keyring, id, placeholder),
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

/**
 * What the hosted tier needs from a database, as an interface.
 *
 * An interface rather than a direct Neon dependency for two reasons. The cron
 * and the screen endpoint are the most consequential code in the hosted tier
 * and both have to be testable without a database. And the obligations in
 * `AGENTS.md` — deletion that actually deletes, no token in a log — are
 * properties of an implementation, so it helps to write them down once, here,
 * and hold every implementation to them.
 *
 * A sealed token never becomes a plaintext token inside this layer. The store
 * moves opaque blobs; `crypto.ts` opens them, and only in the moment a request
 * needs one.
 *
 * There is no webhook URL anywhere in this file, and that is deliberate. TRMNL
 * fetches from the hosted tier rather than being pushed to, so we never receive
 * the URL that authorizes writing to someone's display, and therefore cannot
 * leak it.
 */

import type { SealedToken } from "./crypto.ts";

export type Region = "global" | "china";

/**
 * One hosted user.
 *
 * `id` is ours and is bound into the token's encryption as additional data, so
 * it must never be reused after a deletion and must never be derivable from
 * anything the user hands out.
 */
export interface Account {
  id: string;
  region: Region;
  token: SealedToken;
  /**
   * A keyed tag of the TRMNL installation that owns this account.
   *
   * Never the installation id itself. See `ownerTag` in `crypto.ts` for why it
   * is an HMAC rather than a hash. Unique across accounts, so one installation
   * has one account: this plugin shows up to three printers on one screen, and
   * a second account for the same installation would be a second display,
   * not a feature anyone asked for.
   */
  ownerTag: string;
  /**
   * The printers this account chose. Device ids are printer serials, so they
   * are identifiers: never logged, never sent to TRMNL.
   */
  deviceIds: string[];
  /**
   * An upper bound on the rendered payload. TRMNL documents no size limit for
   * a polled response, unlike the 2 kB webhook ceiling, but a bound still earns
   * its keep: it is what makes the payload builder shed detail in a defined
   * order instead of emitting something unbounded.
   */
  maxPayloadBytes: number;
  exportJobName: boolean;
  /**
   * True once the cloud has refused this token. The cron skips the account
   * rather than retrying, because retrying a refused credential cannot succeed
   * and a loop against a rejecting endpoint is what earns an account a ban.
   */
  reauthRequired: boolean;
}

/**
 * The rendered payload, as the markup route will serve it.
 *
 * This exists because the cron and collector write and the markup route reads,
 * which is the central decision in the design. TRMNL asks for markup on a
 * schedule the *user* chooses, so a route that read Bambu on demand would let
 * one user's refresh setting decide how hard we hit Bambu, would put two cloud
 * round-trips inside TRMNL's request timeout, and would let anyone holding a
 * token generate load on Bambu at will. Serving a stored render makes Bambu's
 * load a function of our own schedule alone.
 */
export interface Screen {
  /** The exact JSON body of merge variables, at the root. */
  body: string;
  /** Bridge clock when it was rendered, epoch milliseconds. */
  renderedAt: number;
}

/**
 * One TRMNL plugin installation, which is the identity a hosted user has.
 *
 * TRMNL mints an access token per installation during the install handshake and
 * presents it as a Bearer token on every markup request, so identity is theirs
 * to run and ours only to verify. What we keep is a keyed tag of that token,
 * never the token itself.
 */
export interface Installation {
  /** Ours, random, unguessable. The subject `ownerTag` is derived from. */
  id: string;
  /** Keyed HMAC of the TRMNL access token. Never the token. */
  accessTokenTag: string;
  /** TRMNL's id for this user-plugin connection. Null until the success webhook. */
  userUuid: string | null;
  /** For deep-linking back to trmnl.com's own settings page. */
  pluginSettingId: number | null;
  /** Null until the person who installed the plugin signs in to Bambu and picks printers. */
  accountId: string | null;
}

export interface Store {
  /**
   * Accounts eligible for a held collector session, in a stable bounded order.
   *
   * Unlike `dueAccounts`, this is a read-only snapshot: it never claims rows or
   * advances `last_serviced_at`. Accounts which require reauthentication or
   * have no selected printers are not collectable.
   */
  collectableAccounts(limit: number): Promise<Account[]>;

  /**
   * Accounts the cron should service, least-recently-serviced first.
   *
   * `renderedBefore` is a cutoff in epoch milliseconds, and its direction is
   * worth stating because it reads backwards at a glance: an account is due when
   * its screen was rendered *before* that instant, so a **later** cutoff makes
   * more accounts due, not fewer. The cron passes `now - DEFER_TO_RENDER_WITHIN_MS`,
   * which advances with the clock. An account whose screen was rendered at or
   * after the cutoff is skipped, because something fresher than this cron has
   * already written one, and an account with no screen at all is always due.
   *
   * That cutoff is what lets a collector and this cron share one table without
   * fighting over it. The collector writes often and richly, so the cron finds
   * those rows fresh and steps aside. When the collector stops, the rows go
   * stale, the cron resumes, and the display falls back to what HTTP can supply
   * rather than going blank. See `docs/COLLECTOR.md`.
   *
   * A skipped account is still claimed, so `last_serviced_at` advances and it
   * does not sit at the front of the queue starving everything behind it.
   */
  dueAccounts(limit: number, renderedBefore: number): Promise<Account[]>;

  accountById(id: string): Promise<Account | null>;

  /**
   * Finds the installation whose access token carries this keyed tag.
   *
   * Takes a tag rather than the token so no implementation is ever handed the
   * live credential, and so the lookup is one indexed equality test. Takes
   * every candidate tag, because a tag cannot be recomputed after a key
   * rotation without the token, which is deliberately not kept.
   */
  installationByTokenTag(candidateTags: readonly string[]): Promise<Installation | null>;

  installationById(id: string): Promise<Installation | null>;

  /**
   * Finds the installation TRMNL's management redirect speaks for.
   *
   * TRMNL appends `?uuid=` to the management URL, and that uuid arrived earlier
   * on the authenticated success webhook. Null for an unknown uuid, and callers
   * treat unknown exactly like absent.
   */
  installationByUserUuid(uuid: string): Promise<Installation | null>;

  /** Creates an installation from the install handshake. */
  createInstallation(installation: Installation): Promise<void>;

  /** Records what the success webhook said about who installed. */
  recordInstallationUser(
    id: string,
    userUuid: string,
    pluginSettingId: number | null,
  ): Promise<void>;

  /** Binds the Bambu account this installation configured. */
  linkInstallationAccount(id: string, accountId: string): Promise<void>;

  /**
   * Removes the installation row itself.
   *
   * The uninstall flow deletes the linked account first — `deleteAccount` is
   * where the actual-deletion obligation lives — and then this removes the
   * token tag, so nothing TRMNL could still present resolves to anything.
   */
  deleteInstallation(id: string): Promise<void>;

  /**
   * Finds the account belonging to a signed-in person.
   *
   * Takes every tag a subject could be stored under rather than one, because a
   * tag cannot be recomputed after a key rotation without the original subject,
   * which is deliberately not kept. Matching any candidate is what keeps an
   * account enrolled under an older key reachable. See `ownerTagCandidates`.
   */
  accountByOwner(candidateTags: readonly string[]): Promise<Account | null>;

  /**
   * Replaces the chosen printers.
   *
   * An empty list is legitimate and means enrolled but not yet configured: the
   * cron has nothing to render and the screen endpoint has nothing to serve.
   * Implementations must not treat it as a deletion.
   */
  replacePrinters(accountId: string, deviceIds: readonly string[]): Promise<void>;

  /** Creates an account and returns it, with the token already sealed. */
  createAccount(account: Omit<Account, "reauthRequired">): Promise<Account>;

  /** Replaces a token in place, for a re-authentication. Clears the flag. */
  replaceToken(accountId: string, token: SealedToken): Promise<void>;

  /** Records that the cloud refused this token, so the cron stops trying. */
  markReauthRequired(accountId: string): Promise<void>;

  /** Null before the cron has rendered anything for this account. */
  readScreen(accountId: string): Promise<Screen | null>;

  writeScreen(accountId: string, screen: Screen): Promise<void>;

  /**
   * Removes the account and everything belonging to it.
   *
   * `AGENTS.md` requires that deletion actually deletes, so this is not a flag:
   * the row and its rendered screen go, and the implementation must not keep a
   * tombstone carrying the token, a device id, or a key fingerprint.
   */
  deleteAccount(accountId: string): Promise<void>;
}

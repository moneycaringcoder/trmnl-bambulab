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
 * leak it. See `docs/DECISIONS.md` D11.
 */

import type { SealedToken } from "./crypto.ts";

export type Region = "global" | "china";

/**
 * One hosted user.
 *
 * `id` is ours and is bound into the token's encryption as additional data, so
 * it must never be reused after a deletion and must never be derivable from
 * anything the user hands out. `screenKeyFingerprint` is what the user *does*
 * hand out, hashed: see `Store.accountByScreenKey`.
 */
export interface Account {
  id: string;
  region: Region;
  token: SealedToken;
  /**
   * SHA-256 of the screen key, hex. The key itself is shown to the user once,
   * at enrolment, and never stored: a database leak then yields no working
   * keys, only fingerprints that cannot be reversed into one.
   */
  screenKeyFingerprint: string;
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
 * The rendered payload, as the screen endpoint will serve it.
 *
 * This exists because the cron writes and the endpoint reads, which is the
 * central decision in the polling design. TRMNL fetches on a schedule the
 * *user* chooses, so an endpoint that read Bambu on demand would let one user's
 * refresh setting decide how hard we hit Bambu, would put two cloud round-trips
 * inside TRMNL's request timeout, and would let anyone holding a key generate
 * load on Bambu at will. Serving a stored render makes Bambu's load a function
 * of our cron alone.
 */
export interface Screen {
  /** The exact JSON body to return, merge variables at the root. */
  body: string;
  /** Bridge clock when it was rendered, epoch milliseconds. */
  renderedAt: number;
}

export interface Store {
  /** Accounts the cron should service, least-recently-serviced first. */
  dueAccounts(limit: number): Promise<Account[]>;

  accountById(id: string): Promise<Account | null>;

  /**
   * Looks an account up by the hash of a presented screen key.
   *
   * Takes a fingerprint rather than a key so that no implementation is ever
   * handed the live credential, and so the lookup is a single indexed equality
   * test rather than a scan. Returns null for an unknown fingerprint, and the
   * caller must answer an unknown key and a revoked one identically.
   */
  accountByScreenKey(fingerprint: string): Promise<Account | null>;

  /** Creates an account and returns it, with the token already sealed. */
  createAccount(account: Omit<Account, "reauthRequired">): Promise<Account>;

  /** Replaces a token in place, for a re-authentication. Clears the flag. */
  replaceToken(accountId: string, token: SealedToken): Promise<void>;

  /** Replaces the screen key, which is how a leaked key is retired. */
  replaceScreenKey(accountId: string, fingerprint: string): Promise<void>;

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

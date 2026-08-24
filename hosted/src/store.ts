/**
 * What the hosted tier needs from a database, as an interface.
 *
 * An interface rather than a direct Neon dependency for two reasons. The cron
 * handler is the most consequential code in the hosted tier and it has to be
 * testable without a database. And the obligations in `AGENTS.md` — deletion
 * that actually deletes, no token in a log — are properties of an
 * implementation, so it helps to be able to write them down once, here, and
 * hold every implementation to them.
 *
 * A sealed token never becomes a plaintext token inside this layer. The store
 * moves opaque blobs; `crypto.ts` opens them, and only in the moment a request
 * needs one.
 */

import type { SealedToken } from "./crypto.ts";

export type Region = "global" | "china";

/**
 * One hosted user. `id` is ours and is the value bound into the token's
 * encryption, so it must never be reused after a deletion.
 */
export interface Account {
  id: string;
  region: Region;
  token: SealedToken;
  /**
   * The printers this account chose. Device ids are printer serials, so they
   * are identifiers: never logged, never sent to TRMNL.
   */
  deviceIds: string[];
  /** A credential: its last path segment authorizes writing to a display. */
  webhookUrl: string;
  maxPushesPerHour: number;
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
 * The scheduler's state between cron invocations.
 *
 * Each cron run is a fresh isolate, so this has to be durable or the rate
 * limiter forgets its budget every five minutes and the twelve-per-hour ceiling
 * stops meaning anything.
 */
export interface PushRecord {
  /** Epoch milliseconds, trailing hour only. */
  recentPushes: number[];
  /** The last body successfully accepted, for change detection. */
  lastSerialized: string | null;
  lastPushedAt: number | null;
}

export interface Store {
  /** Accounts the cron should service, oldest-serviced first. */
  dueAccounts(limit: number): Promise<Account[]>;

  accountById(id: string): Promise<Account | null>;

  /** Creates an account and returns it, with the token already sealed. */
  createAccount(account: Omit<Account, "reauthRequired">): Promise<Account>;

  /** Replaces a token in place, for a re-authentication. Clears the flag. */
  replaceToken(accountId: string, token: SealedToken): Promise<void>;

  /** Records that the cloud refused this token, so the cron stops trying. */
  markReauthRequired(accountId: string): Promise<void>;

  readPushRecord(accountId: string): Promise<PushRecord>;

  writePushRecord(accountId: string, record: PushRecord): Promise<void>;

  /**
   * Removes the account and everything belonging to it.
   *
   * `AGENTS.md` requires that deletion actually deletes, so this is not a flag:
   * the row and its push record go, and the implementation must not keep a
   * tombstone carrying the token, the webhook URL, or a device id.
   */
  deleteAccount(accountId: string): Promise<void>;
}

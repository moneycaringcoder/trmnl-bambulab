/**
 * A complete in-memory implementation of the hosted store contract.
 *
 * Local development and cron tests need the same observable behavior as Neon:
 * oldest-serviced accounts are claimed first, refused credentials are skipped,
 * key fingerprints are indexed, and deleting an account also deletes its
 * rendered screen. This implementation performs no network access and
 * deliberately has no logging surface, so credentials and printer identifiers
 * cannot escape it.
 *
 * It is not durable and refuses to pretend otherwise. Production code must use
 * the Neon implementation; this class exists for one process lifetime only.
 */

import type { SealedToken } from "./crypto.ts";
import type { Account, Screen, Store } from "./store.ts";

interface AccountEntry {
  account: Account;
  createdOrder: number;
  lastServicedOrder: number | null;
}

function copyToken(token: SealedToken): SealedToken {
  return { keyId: token.keyId, nonce: token.nonce, ciphertext: token.ciphertext };
}

function copyAccount(account: Account): Account {
  return {
    id: account.id,
    region: account.region,
    token: copyToken(account.token),
    screenKeyFingerprint: account.screenKeyFingerprint,
    deviceIds: [...account.deviceIds],
    maxPayloadBytes: account.maxPayloadBytes,
    exportJobName: account.exportJobName,
    reauthRequired: account.reauthRequired,
  };
}

export class MemoryStore implements Store {
  private readonly accounts = new Map<string, AccountEntry>();
  private readonly accountIdsByScreenKey = new Map<string, string>();
  private readonly screens = new Map<string, Screen>();
  private createdOrder = 0;
  private servicedOrder = 0;

  async dueAccounts(limit: number): Promise<Account[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("due account limit must be a non-negative safe integer");
    }
    if (limit === 0) return [];

    const due = [...this.accounts.values()]
      .filter((entry) => !entry.account.reauthRequired)
      .sort((left, right) => {
        if (left.lastServicedOrder === null && right.lastServicedOrder !== null) return -1;
        if (left.lastServicedOrder !== null && right.lastServicedOrder === null) return 1;
        if (
          left.lastServicedOrder !== null &&
          right.lastServicedOrder !== null &&
          left.lastServicedOrder !== right.lastServicedOrder
        ) {
          return left.lastServicedOrder - right.lastServicedOrder;
        }
        return left.createdOrder - right.createdOrder;
      })
      .slice(0, limit);

    // A monotonic logical service order avoids wall-clock ties. Moving each
    // claimed account to the back is the in-memory equivalent of Neon updating
    // `last_serviced_at` in the claim statement.
    for (const entry of due) {
      this.servicedOrder += 1;
      entry.lastServicedOrder = this.servicedOrder;
    }
    return due.map((entry) => copyAccount(entry.account));
  }

  async accountById(id: string): Promise<Account | null> {
    const entry = this.accounts.get(id);
    return entry === undefined ? null : copyAccount(entry.account);
  }

  async accountByScreenKey(fingerprint: string): Promise<Account | null> {
    const accountId = this.accountIdsByScreenKey.get(fingerprint);
    if (accountId === undefined) return null;
    const entry = this.accounts.get(accountId);
    return entry === undefined ? null : copyAccount(entry.account);
  }

  async createAccount(account: Omit<Account, "reauthRequired">): Promise<Account> {
    if (this.accounts.has(account.id)) {
      throw new Error("that account already exists");
    }
    if (this.accountIdsByScreenKey.has(account.screenKeyFingerprint)) {
      throw new Error("that screen key fingerprint already exists");
    }

    const created: Account = {
      id: account.id,
      region: account.region,
      token: copyToken(account.token),
      screenKeyFingerprint: account.screenKeyFingerprint,
      deviceIds: [...account.deviceIds],
      maxPayloadBytes: account.maxPayloadBytes,
      exportJobName: account.exportJobName,
      reauthRequired: false,
    };
    this.createdOrder += 1;
    this.accounts.set(created.id, {
      account: created,
      createdOrder: this.createdOrder,
      lastServicedOrder: null,
    });
    this.accountIdsByScreenKey.set(created.screenKeyFingerprint, created.id);

    // Like Neon, there is no screens row until the cron has rendered something.
    return copyAccount(created);
  }

  async replaceToken(accountId: string, token: SealedToken): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (entry === undefined) return;
    entry.account.token = copyToken(token);
    entry.account.reauthRequired = false;
  }

  async replaceScreenKey(accountId: string, fingerprint: string): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (entry === undefined) return;

    const owner = this.accountIdsByScreenKey.get(fingerprint);
    if (owner !== undefined && owner !== accountId) {
      throw new Error("that screen key fingerprint already exists");
    }

    this.accountIdsByScreenKey.delete(entry.account.screenKeyFingerprint);
    entry.account.screenKeyFingerprint = fingerprint;
    this.accountIdsByScreenKey.set(fingerprint, accountId);
  }

  async markReauthRequired(accountId: string): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (entry !== undefined) entry.account.reauthRequired = true;
  }

  async readScreen(accountId: string): Promise<Screen | null> {
    const screen = this.screens.get(accountId);
    return screen === undefined ? null : { body: screen.body, renderedAt: screen.renderedAt };
  }

  async writeScreen(accountId: string, screen: Screen): Promise<void> {
    if (!this.accounts.has(accountId)) {
      throw new Error("that account does not exist");
    }
    if (typeof screen.body !== "string") {
      throw new Error('column "body" drifted: expected a string');
    }
    if (!Number.isSafeInteger(screen.renderedAt) || screen.renderedAt < 0) {
      throw new Error('column "rendered_at" drifted: expected a non-negative safe integer');
    }
    this.screens.set(accountId, { body: screen.body, renderedAt: screen.renderedAt });
  }

  async deleteAccount(accountId: string): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (entry === undefined) return;

    // Keep the cascade structural here too: there is no tombstone and no path
    // which removes the account while retaining its payload or fingerprint.
    this.accountIdsByScreenKey.delete(entry.account.screenKeyFingerprint);
    this.accounts.delete(accountId);
    this.screens.delete(accountId);
  }
}

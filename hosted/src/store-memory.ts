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
import type { Account, Installation, Screen, Store } from "./store.ts";

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
    ownerTag: account.ownerTag,
    region: account.region,
    token: copyToken(account.token),
    deviceIds: [...account.deviceIds],
    maxPayloadBytes: account.maxPayloadBytes,
    exportJobName: account.exportJobName,
    reauthRequired: account.reauthRequired,
  };
}

export class MemoryStore implements Store {
  private readonly accounts = new Map<string, AccountEntry>();
  private readonly installations = new Map<string, Installation>();
  private readonly installationIdsByTokenTag = new Map<string, string>();
  private readonly accountIdsByOwnerTag = new Map<string, string>();
  private readonly screens = new Map<string, Screen>();
  private createdOrder = 0;
  private servicedOrder = 0;

  async dueAccounts(limit: number, renderedBefore: number): Promise<Account[]> {
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

    // Dropped after claiming, not before, so an account something else keeps
    // rendering spends its turn instead of parking at the head of the queue.
    return due
      .filter((entry) => {
        const screen = this.screens.get(entry.account.id);
        return screen === undefined || screen.renderedAt < renderedBefore;
      })
      .map((entry) => copyAccount(entry.account));
  }

  async accountById(id: string): Promise<Account | null> {
    const entry = this.accounts.get(id);
    return entry === undefined ? null : copyAccount(entry.account);
  }

  async accountByOwner(candidateTags: readonly string[]): Promise<Account | null> {
    for (const candidateTag of candidateTags) {
      const accountId = this.accountIdsByOwnerTag.get(candidateTag);
      if (accountId === undefined) continue;
      const entry = this.accounts.get(accountId);
      if (entry !== undefined) return copyAccount(entry.account);
    }
    return null;
  }

  async installationByTokenTag(candidateTags: readonly string[]): Promise<Installation | null> {
    for (const candidateTag of candidateTags) {
      const id = this.installationIdsByTokenTag.get(candidateTag);
      if (id === undefined) continue;
      const installation = this.installations.get(id);
      if (installation !== undefined) return { ...installation };
    }
    return null;
  }

  async installationById(id: string): Promise<Installation | null> {
    const installation = this.installations.get(id);
    return installation === undefined ? null : { ...installation };
  }

  async createInstallation(installation: Installation): Promise<void> {
    if (this.installations.has(installation.id)) {
      throw new Error("that installation already exists");
    }
    if (this.installationIdsByTokenTag.has(installation.accessTokenTag)) {
      throw new Error("that access token tag already exists");
    }
    this.installations.set(installation.id, { ...installation });
    this.installationIdsByTokenTag.set(installation.accessTokenTag, installation.id);
  }

  async recordInstallationUser(
    id: string,
    userUuid: string,
    pluginSettingId: number | null,
  ): Promise<void> {
    const installation = this.installations.get(id);
    if (installation === undefined) return;
    installation.userUuid = userUuid;
    installation.pluginSettingId = pluginSettingId;
  }

  async linkInstallationAccount(id: string, accountId: string): Promise<void> {
    const installation = this.installations.get(id);
    if (installation !== undefined) installation.accountId = accountId;
  }

  async deleteInstallation(id: string): Promise<void> {
    const installation = this.installations.get(id);
    if (installation === undefined) return;
    this.installationIdsByTokenTag.delete(installation.accessTokenTag);
    this.installations.delete(id);
  }

  async createAccount(account: Omit<Account, "reauthRequired">): Promise<Account> {
    if (this.accounts.has(account.id)) {
      throw new Error("that account already exists");
    }
    if (this.accountIdsByOwnerTag.has(account.ownerTag)) {
      throw new Error("that owner tag already exists");
    }

    const created: Account = {
      id: account.id,
      ownerTag: account.ownerTag,
      region: account.region,
      token: copyToken(account.token),
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
    this.accountIdsByOwnerTag.set(created.ownerTag, created.id);

    // Like Neon, there is no screens row until the cron has rendered something.
    return copyAccount(created);
  }

  async replaceToken(accountId: string, token: SealedToken): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (entry === undefined) return;
    entry.account.token = copyToken(token);
    entry.account.reauthRequired = false;
  }

  async replacePrinters(accountId: string, deviceIds: readonly string[]): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (entry !== undefined) entry.account.deviceIds = [...deviceIds];
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
    // which removes the account while retaining its payload or token.
    this.accountIdsByOwnerTag.delete(entry.account.ownerTag);
    this.accounts.delete(accountId);
    this.screens.delete(accountId);
    // Mirrors the schema's ON DELETE SET NULL: the installation outlives a
    // deleted account and can enrol a fresh one.
    for (const installation of this.installations.values()) {
      if (installation.accountId === accountId) installation.accountId = null;
    }
  }
}

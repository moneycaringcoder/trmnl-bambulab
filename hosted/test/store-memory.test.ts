/**
 * Observable Store behavior exercised without a database.
 *
 * Identifiers and credential-shaped values are assembled at runtime so this
 * test cannot be mistaken for a captured account, printer, or webhook.
 */

import { describe, expect, it } from "vitest";

import { MemoryStore } from "../src/store-memory.ts";
import type { Account } from "../src/store.ts";

function account(label: string): Omit<Account, "reauthRequired"> {
  const id = ["account", label, crypto.randomUUID()].join("-");
  return {
    id,
    region: "global",
    token: {
      keyId: "test-key",
      nonce: btoa(["nonce", label].join("-")),
      ciphertext: btoa(["ciphertext", label].join("-")),
    },
    deviceIds: [["D", label, crypto.randomUUID()].join("-")],
    webhookUrl: ["https:", "", "display.invalid", "hook", crypto.randomUUID()].join("/"),
    maxPushesPerHour: 12,
    maxPayloadBytes: 2_000,
    exportJobName: false,
  };
}

describe("MemoryStore", () => {
  it("orders never-serviced accounts first and excludes reauthentication", async () => {
    const store = new MemoryStore();
    const first = account("first");
    const refused = account("refused");
    const third = account("third");
    await store.createAccount(first);
    await store.createAccount(refused);
    await store.createAccount(third);
    await store.markReauthRequired(refused.id);

    expect((await store.dueAccounts(2)).map(({ id }) => id)).toEqual([first.id, third.id]);
    expect((await store.dueAccounts(2)).map(({ id }) => id)).toEqual([first.id, third.id]);
  });

  it("advances service order so one account cannot stay first forever", async () => {
    const store = new MemoryStore();
    const first = account("rotation-a");
    const second = account("rotation-b");
    await store.createAccount(first);
    await store.createAccount(second);

    expect((await store.dueAccounts(1))[0]?.id).toBe(first.id);
    expect((await store.dueAccounts(1))[0]?.id).toBe(second.id);
    expect((await store.dueAccounts(1))[0]?.id).toBe(first.id);
  });

  it("replaceToken clears the reauthentication flag", async () => {
    const store = new MemoryStore();
    const original = account("replace");
    await store.createAccount(original);
    await store.markReauthRequired(original.id);
    const replacement = {
      keyId: "replacement-key",
      nonce: btoa("replacement-nonce"),
      ciphertext: btoa("replacement-ciphertext"),
    };

    await store.replaceToken(original.id, replacement);

    expect(await store.accountById(original.id)).toMatchObject({
      token: replacement,
      reauthRequired: false,
    });
    expect((await store.dueAccounts(1))[0]?.id).toBe(original.id);
  });

  it("deleting an account also removes its push record", async () => {
    const store = new MemoryStore();
    const original = account("delete");
    await store.createAccount(original);
    await store.writePushRecord(original.id, {
      recentPushes: [Date.now()],
      lastSerialized: JSON.stringify({ changed: true }),
      lastPushedAt: Date.now(),
    });

    await store.deleteAccount(original.id);

    await expect(store.accountById(original.id)).resolves.toBeNull();
    await expect(store.readPushRecord(original.id)).resolves.toEqual({
      recentPushes: [],
      lastSerialized: null,
      lastPushedAt: null,
    });
  });
});

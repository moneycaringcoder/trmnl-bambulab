/**
 * Observable Store behavior exercised without a database.
 *
 * Identifiers and credential-shaped values are assembled at runtime so this
 * test cannot be mistaken for a captured account, printer, or screen key.
 */

import { describe, expect, it } from "vitest";

import { screenKeyFingerprint } from "../src/crypto.ts";
import { MemoryStore } from "../src/store-memory.ts";
import type { Account } from "../src/store.ts";

async function account(label: string): Promise<Omit<Account, "reauthRequired">> {
  const id = ["account", label, crypto.randomUUID()].join("-");
  const presentedScreenKey = ["screen", label, crypto.randomUUID()].join("-");
  return {
    id,
    region: "global",
    token: {
      keyId: ["test", "key", label].join("-"),
      nonce: btoa(["nonce", label, crypto.randomUUID()].join("-")),
      ciphertext: btoa(["ciphertext", label, crypto.randomUUID()].join("-")),
    },
    screenKeyFingerprint: await screenKeyFingerprint(presentedScreenKey),
    deviceIds: [["D", label, crypto.randomUUID()].join("-")],
    maxPayloadBytes: 2_000,
    exportJobName: false,
  };
}

function renderedBody(label: string): string {
  return JSON.stringify({
    v: 1,
    updated_at: new Date().toISOString(),
    printers: [{ name: ["printer", label, crypto.randomUUID()].join("-") }],
    hidden: 0,
    cloud: "connected",
  });
}

describe("MemoryStore", () => {
  it("orders due accounts and excludes accounts requiring reauthentication", async () => {
    const store = new MemoryStore();
    const first = await account("first");
    const refused = await account("refused");
    const third = await account("third");
    await store.createAccount(first);
    await store.createAccount(refused);
    await store.createAccount(third);
    await store.markReauthRequired(refused.id);

    expect((await store.dueAccounts(2)).map(({ id }) => id)).toEqual([first.id, third.id]);
    expect((await store.dueAccounts(2)).map(({ id }) => id)).toEqual([first.id, third.id]);
  });

  it("advances service order so one account cannot stay first forever", async () => {
    const store = new MemoryStore();
    const first = await account("rotation-a");
    const second = await account("rotation-b");
    await store.createAccount(first);
    await store.createAccount(second);

    expect((await store.dueAccounts(1))[0]?.id).toBe(first.id);
    expect((await store.dueAccounts(1))[0]?.id).toBe(second.id);
    expect((await store.dueAccounts(1))[0]?.id).toBe(first.id);
  });

  it("finds an account by screen key fingerprint even when reauthentication is required", async () => {
    const store = new MemoryStore();
    const original = await account("screen-lookup");
    await store.createAccount(original);
    const unknown = await screenKeyFingerprint(
      ["unknown", "screen", crypto.randomUUID()].join("-"),
    );

    await expect(store.accountByScreenKey(original.screenKeyFingerprint)).resolves.toMatchObject({
      id: original.id,
      reauthRequired: false,
    });
    await expect(store.accountByScreenKey(unknown)).resolves.toBeNull();

    await store.markReauthRequired(original.id);

    await expect(store.accountByScreenKey(original.screenKeyFingerprint)).resolves.toMatchObject({
      id: original.id,
      reauthRequired: true,
    });
  });

  it("retires the old fingerprint when replacing a screen key", async () => {
    const store = new MemoryStore();
    const original = await account("screen-rotation");
    await store.createAccount(original);
    const replacement = await screenKeyFingerprint(
      ["replacement", "screen", crypto.randomUUID()].join("-"),
    );

    await store.replaceScreenKey(original.id, replacement);

    await expect(store.accountByScreenKey(original.screenKeyFingerprint)).resolves.toBeNull();
    await expect(store.accountByScreenKey(replacement)).resolves.toMatchObject({
      id: original.id,
      screenKeyFingerprint: replacement,
    });
  });

  it("replaceToken clears the reauthentication flag", async () => {
    const store = new MemoryStore();
    const original = await account("replace-token");
    await store.createAccount(original);
    await store.markReauthRequired(original.id);
    const replacement = {
      keyId: ["replacement", "key"].join("-"),
      nonce: btoa(["replacement", "nonce", crypto.randomUUID()].join("-")),
      ciphertext: btoa(["replacement", "ciphertext", crypto.randomUUID()].join("-")),
    };

    await store.replaceToken(original.id, replacement);

    expect(await store.accountById(original.id)).toMatchObject({
      token: replacement,
      reauthRequired: false,
    });
    expect((await store.dueAccounts(1))[0]?.id).toBe(original.id);
  });

  it("returns null before a render and defensively copies a written screen", async () => {
    const store = new MemoryStore();
    const original = await account("screen-write");
    await store.createAccount(original);
    const screen = { body: renderedBody("first"), renderedAt: Date.now() };
    const expected = { ...screen };

    await expect(store.readScreen(original.id)).resolves.toBeNull();
    await store.writeScreen(original.id, screen);
    screen.body = renderedBody("mutated-input");
    screen.renderedAt += 1;

    const firstRead = await store.readScreen(original.id);
    expect(firstRead).toEqual(expected);
    if (firstRead === null) throw new Error("the written screen was unexpectedly absent");
    firstRead.body = renderedBody("mutated-result");
    firstRead.renderedAt += 1;

    await expect(store.readScreen(original.id)).resolves.toEqual(expected);
  });

  it("defensively copies accounts and their nested values", async () => {
    const store = new MemoryStore();
    const original = await account("account-copy");
    const expectedToken = { ...original.token };
    const expectedDeviceIds = [...original.deviceIds];
    const created = await store.createAccount(original);

    original.token.ciphertext = btoa(["mutated", crypto.randomUUID()].join("-"));
    original.deviceIds.push(["mutated", crypto.randomUUID()].join("-"));
    created.token.nonce = btoa(["mutated", crypto.randomUUID()].join("-"));
    created.deviceIds.length = 0;

    await expect(store.accountById(original.id)).resolves.toMatchObject({
      token: expectedToken,
      deviceIds: expectedDeviceIds,
    });
  });

  it("deleting an account also removes its screen and fingerprint", async () => {
    const store = new MemoryStore();
    const original = await account("delete");
    await store.createAccount(original);
    await store.writeScreen(original.id, {
      body: renderedBody("delete"),
      renderedAt: Date.now(),
    });

    await store.deleteAccount(original.id);

    await expect(store.accountById(original.id)).resolves.toBeNull();
    await expect(store.accountByScreenKey(original.screenKeyFingerprint)).resolves.toBeNull();
    await expect(store.readScreen(original.id)).resolves.toBeNull();
  });
});

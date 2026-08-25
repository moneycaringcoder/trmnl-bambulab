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
import { ownerTagForTest } from "./helpers.ts";

/**
 * A cutoff far in the future, so no account is skipped for having a fresh
 * render. These cases are about claim ordering, not about the freshness gate,
 * which has its own cases below.
 */
const ANY_RENDER = Number.MAX_SAFE_INTEGER;

async function account(label: string): Promise<Omit<Account, "reauthRequired">> {
  const id = ["account", label, crypto.randomUUID()].join("-");
  const presentedScreenKey = ["screen", label, crypto.randomUUID()].join("-");
  return {
    id,
    ownerTag: ownerTagForTest(),
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

    expect((await store.dueAccounts(2, ANY_RENDER)).map(({ id }) => id)).toEqual([first.id, third.id]);
    expect((await store.dueAccounts(2, ANY_RENDER)).map(({ id }) => id)).toEqual([first.id, third.id]);
  });

  it("advances service order so one account cannot stay first forever", async () => {
    const store = new MemoryStore();
    const first = await account("rotation-a");
    const second = await account("rotation-b");
    await store.createAccount(first);
    await store.createAccount(second);

    expect((await store.dueAccounts(1, ANY_RENDER))[0]?.id).toBe(first.id);
    expect((await store.dueAccounts(1, ANY_RENDER))[0]?.id).toBe(second.id);
    expect((await store.dueAccounts(1, ANY_RENDER))[0]?.id).toBe(first.id);
  });

  // The gate that lets a collector and the cron share one table. See D18.
  it("skips an account something has rendered more recently than the cutoff", async () => {
    const store = new MemoryStore();
    const fresh = await account("gate-fresh");
    const stale = await account("gate-stale");
    await store.createAccount(fresh);
    await store.createAccount(stale);

    const cutoff = 1_000_000;
    await store.writeScreen(fresh.id, { body: "{}", renderedAt: cutoff });
    await store.writeScreen(stale.id, { body: "{}", renderedAt: cutoff - 1 });

    // At the cutoff exactly is fresh: the boundary belongs to the writer that
    // got there first, so the cron does not race it.
    expect((await store.dueAccounts(5, cutoff)).map(({ id }) => id)).toEqual([stale.id]);
  });

  it("treats an account with no render at all as due", async () => {
    const store = new MemoryStore();
    const never = await account("gate-never");
    await store.createAccount(never);

    expect((await store.dueAccounts(5, Number.MAX_SAFE_INTEGER)).map(({ id }) => id)).toEqual([
      never.id,
    ]);
  });

  // A collector writing every few seconds would otherwise park its accounts at
  // the head of the queue forever, and everything behind them would starve.
  it("spends a skipped account's turn rather than deferring it", async () => {
    const store = new MemoryStore();
    const covered = await account("gate-covered");
    const waiting = await account("gate-waiting");
    await store.createAccount(covered);
    await store.createAccount(waiting);

    const cutoff = 2_000_000;
    await store.writeScreen(covered.id, { body: "{}", renderedAt: cutoff });

    // One slot per call, and `covered` sorts first. If its turn were deferred
    // rather than spent, `waiting` would never come up.
    expect((await store.dueAccounts(1, cutoff)).map(({ id }) => id)).toEqual([]);
    expect((await store.dueAccounts(1, cutoff)).map(({ id }) => id)).toEqual([waiting.id]);
  });

  it("returns everything once the renders have gone stale", async () => {
    const store = new MemoryStore();
    const one = await account("gate-thaw-a");
    const two = await account("gate-thaw-b");
    await store.createAccount(one);
    await store.createAccount(two);
    await store.writeScreen(one.id, { body: "{}", renderedAt: 500 });
    await store.writeScreen(two.id, { body: "{}", renderedAt: 500 });

    // The collector stopped, so both rows aged past the cutoff and the cron
    // takes them back rather than leaving the displays to freeze.
    expect((await store.dueAccounts(5, 5_000)).map(({ id }) => id).sort()).toEqual(
      [one.id, two.id].sort(),
    );
  });

  it("finds an account by any owner tag candidate", async () => {
    const store = new MemoryStore();
    const original = await account("owner-match");
    await store.createAccount(original);
    const unknown = ownerTagForTest();

    await expect(store.accountByOwner([original.ownerTag, unknown])).resolves.toMatchObject({
      id: original.id,
      ownerTag: original.ownerTag,
    });
    await expect(store.accountByOwner([unknown, original.ownerTag])).resolves.toMatchObject({
      id: original.id,
      ownerTag: original.ownerTag,
    });
  });

  it("returns null when no owner tag candidate matches", async () => {
    const store = new MemoryStore();
    await store.createAccount(await account("owner-miss"));

    await expect(
      store.accountByOwner([ownerTagForTest(), ownerTagForTest()]),
    ).resolves.toBeNull();
  });

  it("returns null for an empty owner tag candidate array", async () => {
    const store = new MemoryStore();
    await store.createAccount(await account("owner-empty"));

    await expect(store.accountByOwner([])).resolves.toBeNull();
  });

  it("replaces printers instead of appending and stores an empty selection", async () => {
    const store = new MemoryStore();
    const original = await account("replace-printers");
    await store.createAccount(original);
    const replacement = [
      ["D", "replacement-a", crypto.randomUUID()].join("-"),
      ["D", "replacement-b", crypto.randomUUID()].join("-"),
    ];
    const expectedReplacement = [...replacement];

    await store.replacePrinters(original.id, replacement);
    replacement.push(["D", "mutated", crypto.randomUUID()].join("-"));

    await expect(store.accountById(original.id)).resolves.toMatchObject({
      deviceIds: expectedReplacement,
    });

    await store.replacePrinters(original.id, []);

    await expect(store.accountById(original.id)).resolves.toMatchObject({
      id: original.id,
      deviceIds: [],
    });
  });

  it("refuses a duplicate owner tag", async () => {
    const store = new MemoryStore();
    const original = await account("owner-unique");
    const duplicate = await account("owner-duplicate");
    duplicate.ownerTag = original.ownerTag;
    await store.createAccount(original);

    await expect(store.createAccount(duplicate)).rejects.toThrow("that owner tag already exists");
    await expect(store.accountById(duplicate.id)).resolves.toBeNull();
  });

  it("deletion releases the owner tag for re-enrolment", async () => {
    const store = new MemoryStore();
    const original = await account("owner-delete");
    await store.createAccount(original);

    await store.deleteAccount(original.id);

    await expect(store.accountByOwner([original.ownerTag])).resolves.toBeNull();
    const reEnrolled = await account("owner-re-enrolled");
    reEnrolled.ownerTag = original.ownerTag;
    await expect(store.createAccount(reEnrolled)).resolves.toMatchObject({
      id: reEnrolled.id,
      ownerTag: original.ownerTag,
    });
  });

  it("finds an account by screen key fingerprint even when reauthentication is required", async () => {
    const store = new MemoryStore();
    const original = await account("screen-lookup");
    await store.createAccount(original);
    const unknown = await screenKeyFingerprint(
      ["unknown", "screen", crypto.randomUUID()].join("-"),
    );

    await expect(store.pollByScreenKey(original.screenKeyFingerprint)).resolves.toMatchObject({
      account: {
        id: original.id,
        reauthRequired: false,
      },
      screen: null,
    });
    await expect(store.pollByScreenKey(unknown)).resolves.toBeNull();

    await store.markReauthRequired(original.id);

    await expect(store.pollByScreenKey(original.screenKeyFingerprint)).resolves.toMatchObject({
      account: {
        id: original.id,
        reauthRequired: true,
      },
      screen: null,
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

    await expect(store.pollByScreenKey(original.screenKeyFingerprint)).resolves.toBeNull();
    await expect(store.pollByScreenKey(replacement)).resolves.toMatchObject({
      account: {
        id: original.id,
        screenKeyFingerprint: replacement,
      },
      screen: null,
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
    expect((await store.dueAccounts(1, ANY_RENDER))[0]?.id).toBe(original.id);
  });

  it("returns null before a render and defensively copies a written screen", async () => {
    const store = new MemoryStore();
    const original = await account("screen-write");
    await store.createAccount(original);
    const screen = { body: renderedBody("first"), renderedAt: Date.now() };
    const expected = { ...screen };

    await expect(store.pollByScreenKey(original.screenKeyFingerprint)).resolves.toMatchObject({
      screen: null,
    });
    await store.writeScreen(original.id, screen);
    screen.body = renderedBody("mutated-input");
    screen.renderedAt += 1;

    const firstPoll = await store.pollByScreenKey(original.screenKeyFingerprint);
    expect(firstPoll?.screen).toEqual(expected);
    if (firstPoll === null || firstPoll.screen === null) {
      throw new Error("the written screen was unexpectedly absent");
    }
    firstPoll.screen.body = renderedBody("mutated-result");
    firstPoll.screen.renderedAt += 1;

    await expect(store.pollByScreenKey(original.screenKeyFingerprint)).resolves.toMatchObject({
      screen: expected,
    });
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

    const poll = await store.pollByScreenKey(original.screenKeyFingerprint);
    expect(poll?.account).toMatchObject({
      token: expectedToken,
      deviceIds: expectedDeviceIds,
    });
    if (poll === null) throw new Error("the account was unexpectedly absent");
    poll.account.token.keyId = ["mutated", crypto.randomUUID()].join("-");
    poll.account.deviceIds.length = 0;

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
    await expect(store.pollByScreenKey(original.screenKeyFingerprint)).resolves.toBeNull();
    await expect(store.readScreen(original.id)).resolves.toBeNull();
  });
});

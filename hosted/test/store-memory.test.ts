/**
 * Observable Store behavior exercised without a database.
 *
 * Identifiers and credential-shaped values are assembled at runtime so this
 * test cannot be mistaken for a captured account, printer, or screen key.
 */

import { describe, expect, it } from "vitest";

import { MemoryStore } from "@trmnl-bambulab/core/hosted/store-memory";
import type { Account, Installation } from "@trmnl-bambulab/core/hosted/store";
import { ownerTagForTest } from "./helpers.ts";

/**
 * A cutoff far in the future, so no account is skipped for having a fresh
 * render. These cases are about claim ordering, not about the freshness gate,
 * which has its own cases below.
 */
const ANY_RENDER = Number.MAX_SAFE_INTEGER;

function account(label: string): Omit<Account, "reauthRequired"> {
  const id = ["account", label, crypto.randomUUID()].join("-");
  return {
    id,
    ownerTag: ownerTagForTest(),
    region: "global",
    token: {
      keyId: ["test", "key", label].join("-"),
      nonce: btoa(["nonce", label, crypto.randomUUID()].join("-")),
      ciphertext: btoa(["ciphertext", label, crypto.randomUUID()].join("-")),
    },
    deviceIds: [["D", label, crypto.randomUUID()].join("-")],
    maxPayloadBytes: 2_000,
    exportJobName: false,
  };
}

function installation(label: string): Installation {
  return {
    id: ["installation", label, crypto.randomUUID()].join("-"),
    accessTokenTag: ownerTagForTest(),
    userUuid: null,
    pluginSettingId: null,
    accountId: null,
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

  it("discovers collectable accounts read-only in stable creation order", async () => {
    const store = new MemoryStore();
    const first = await store.createAccount(account("collectable-first"));
    const disabledInput = account("collectable-disabled");
    disabledInput.deviceIds = [];
    await store.createAccount(disabledInput);
    const second = await store.createAccount(account("collectable-second"));
    const refused = await store.createAccount(account("collectable-refused"));
    await store.markReauthRequired(refused.id);

    await expect(store.collectableAccounts(10)).resolves.toEqual([first, second]);
    await expect(store.collectableAccounts(10)).resolves.toEqual([first, second]);
    // A read-only discovery must not spend the first account's cron turn.
    expect((await store.dueAccounts(1, ANY_RENDER))[0]?.id).toBe(first.id);
    await expect(store.collectableAccounts(1)).resolves.toEqual([first]);
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

  it("finds an installation by any token tag candidate and returns null for unknown tags", async () => {
    const store = new MemoryStore();
    const original = installation("token-match");
    const unknown = ownerTagForTest();
    await store.createInstallation(original);

    await expect(
      store.installationByTokenTag([unknown, original.accessTokenTag]),
    ).resolves.toEqual(original);
    await expect(
      store.installationByTokenTag([original.accessTokenTag, unknown]),
    ).resolves.toEqual(original);
    await expect(store.installationByTokenTag([unknown])).resolves.toBeNull();
  });

  it("refuses duplicate installation ids and token tags", async () => {
    const store = new MemoryStore();
    const original = installation("unique");
    const duplicateId = installation("duplicate-id");
    duplicateId.id = original.id;
    const duplicateTag = installation("duplicate-tag");
    duplicateTag.accessTokenTag = original.accessTokenTag;
    await store.createInstallation(original);

    await expect(store.createInstallation(duplicateId)).rejects.toThrow(
      "that installation already exists",
    );
    await expect(store.createInstallation(duplicateTag)).rejects.toThrow(
      "that access token tag already exists",
    );
    await expect(store.installationById(duplicateTag.id)).resolves.toBeNull();
  });

  it("records installation user details and links an account without creating unknown rows", async () => {
    const store = new MemoryStore();
    const original = installation("update");
    const userUuid = ["user", crypto.randomUUID()].join("-");
    const accountId = ["account", crypto.randomUUID()].join("-");
    const unknownId = ["unknown", crypto.randomUUID()].join("-");
    await store.createInstallation(original);

    await store.recordInstallationUser(original.id, userUuid, 42);
    await store.linkInstallationAccount(original.id, accountId);

    await expect(store.installationById(original.id)).resolves.toEqual({
      ...original,
      userUuid,
      pluginSettingId: 42,
      accountId,
    });

    await expect(
      store.recordInstallationUser(unknownId, userUuid, null),
    ).resolves.toBeUndefined();
    await expect(
      store.linkInstallationAccount(unknownId, accountId),
    ).resolves.toBeUndefined();
    await expect(store.installationById(unknownId)).resolves.toBeNull();
  });
  it("enforces installation user and account uniqueness while allowing same-row repeats", async () => {
    const store = new MemoryStore();
    const first = installation("unique-fields-first");
    const second = installation("unique-fields-second");
    const userOne = ["user", "one", crypto.randomUUID()].join("-");
    const userTwo = ["user", "two", crypto.randomUUID()].join("-");
    const accountOne = (await store.createAccount(account("linked-one"))).id;
    const accountTwo = (await store.createAccount(account("linked-two"))).id;
    await store.createInstallation(first);
    await store.createInstallation(second);

    await store.recordInstallationUser(first.id, userOne, 10);
    await store.recordInstallationUser(first.id, userOne, 10);
    await expect(store.recordInstallationUser(second.id, userOne, 20)).rejects.toThrow(
      "that user uuid already belongs to an installation",
    );
    await store.recordInstallationUser(first.id, userTwo, 11);
    await expect(store.recordInstallationUser(second.id, userOne, 20)).resolves.toBeUndefined();

    await store.linkInstallationAccount(first.id, accountOne);
    await store.linkInstallationAccount(first.id, accountOne);
    await expect(store.linkInstallationAccount(second.id, accountOne)).rejects.toThrow(
      "that account already belongs to an installation",
    );
    await store.linkInstallationAccount(first.id, accountTwo);
    await expect(store.linkInstallationAccount(second.id, accountOne)).resolves.toBeUndefined();

    const duplicateUser = installation("duplicate-user");
    duplicateUser.userUuid = userOne;
    await expect(store.createInstallation(duplicateUser)).rejects.toThrow(
      "that user uuid already belongs to an installation",
    );
    const duplicateAccount = installation("duplicate-account");
    duplicateAccount.accountId = accountOne;
    await expect(store.createInstallation(duplicateAccount)).rejects.toThrow(
      "that account already belongs to an installation",
    );
    await store.deleteInstallation(second.id);
    const recycled = installation("recycled-unique-fields");
    recycled.userUuid = userOne;
    recycled.accountId = accountOne;
    await expect(store.createInstallation(recycled)).resolves.toBeUndefined();
  });

  it("deletes an installation row and its token tag lookup", async () => {
    const store = new MemoryStore();
    const original = installation("delete");
    await store.createInstallation(original);

    await store.deleteInstallation(original.id);

    await expect(store.installationById(original.id)).resolves.toBeNull();
    await expect(
      store.installationByTokenTag([original.accessTokenTag]),
    ).resolves.toBeNull();
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

    await expect(store.readScreen(original.id)).resolves.toBeNull();
    await store.writeScreen(original.id, screen);
    screen.body = renderedBody("mutated-input");
    screen.renderedAt += 1;

    const firstRead = await store.readScreen(original.id);
    expect(firstRead).toEqual(expected);
    if (firstRead === null) {
      throw new Error("the written screen was unexpectedly absent");
    }
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

    const stored = await store.accountById(original.id);
    expect(stored).toMatchObject({
      token: expectedToken,
      deviceIds: expectedDeviceIds,
    });
    if (stored === null) throw new Error("the account was unexpectedly absent");
    stored.token.keyId = ["mutated", crypto.randomUUID()].join("-");
    stored.deviceIds.length = 0;

    await expect(store.accountById(original.id)).resolves.toMatchObject({
      token: expectedToken,
      deviceIds: expectedDeviceIds,
    });
  });

  it("deleting an account cascades its screen without deleting its installation", async () => {
    const store = new MemoryStore();
    const original = await account("delete");
    const linkedInstallation = installation("account-delete");
    linkedInstallation.accountId = original.id;
    await store.createAccount(original);
    await store.createInstallation(linkedInstallation);
    await store.writeScreen(original.id, {
      body: renderedBody("delete"),
      renderedAt: Date.now(),
    });

    await store.deleteAccount(original.id);

    await expect(store.accountById(original.id)).resolves.toBeNull();
    await expect(store.readScreen(original.id)).resolves.toBeNull();
    // The installation survives with its link nulled, mirroring the schema's
    // ON DELETE SET NULL: TRMNL still has the plugin installed, and the next
    // enrolment relinks it.
    const survivor = { ...linkedInstallation, accountId: null };
    await expect(store.installationById(linkedInstallation.id)).resolves.toEqual(survivor);
    await expect(
      store.installationByTokenTag([linkedInstallation.accessTokenTag]),
    ).resolves.toEqual(survivor);
  });
});

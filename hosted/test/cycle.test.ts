/**
 * Hosted cycle behavior at the storage boundary.
 *
 * The network is a stubbed Bambu Cloud HTTP surface. It deliberately has no
 * TRMNL branch: the hosted cycle renders into the store and refuses to acquire
 * any capability that could write to a display or a printer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importKeyring,
  newScreenKey,
  sealToken,
  type Keyring,
} from "../src/crypto.ts";
import { networkDependencies, runCycle, runDueAccounts } from "../src/cycle.ts";
import { MemoryStore } from "../src/store-memory.ts";
import type { Account } from "../src/store.ts";
import { ownerTagForTest } from "./helpers.ts";
import { DEVICE_ID } from "../../bridge/test/synthetic-values.ts";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const TOKEN = ["synthetic", "cloud", "token"].join("-");

interface StubOptions {
  cloudStatus?: number;
}

function stubCloud(options: StubOptions = {}) {
  const progress = 42;
  const calls = { count: 0 };
  const cloudStatus = options.cloudStatus ?? 200;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    calls.count += 1;
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/user/bind")) {
      if (cloudStatus !== 200) return new Response("refused", { status: cloudStatus });
      return new Response(
        JSON.stringify({
          devices: [
            {
              dev_id: DEVICE_ID,
              name: "Synthetic printer",
              dev_model_name: "Synthetic model",
              online: true,
              print_status: "RUNNING",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/user/print")) {
      if (cloudStatus !== 200) return new Response("refused", { status: cloudStatus });
      return new Response(
        JSON.stringify({
          devices: [
            {
              dev_id: DEVICE_ID,
              dev_online: true,
              task_status: "RUNNING",
              progress,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error("the hosted cycle made an unexpected outbound request");
  });

  return calls;
}

async function keyring(): Promise<Keyring> {
  const bytes = new Uint8Array(32);
  bytes.fill(7);
  const encoded = btoa(String.fromCharCode(...bytes));
  return importKeyring({ k1: encoded }, "k1");
}

interface AccountOptions {
  suffix?: string;
  maxPayloadBytes?: number;
}

interface CreatedAccount {
  account: Account;
  screenKey: string;
}

async function createAccount(
  store: MemoryStore,
  keys: Keyring,
  options: AccountOptions = {},
): Promise<CreatedAccount> {
  const id = ["account", options.suffix ?? "one"].join("-");
  const screenKey = newScreenKey();
  const account = await store.createAccount({
    id,
    ownerTag: ownerTagForTest(),
    region: "global",
    token: await sealToken(keys, id, TOKEN),
    deviceIds: [DEVICE_ID],
    maxPayloadBytes: options.maxPayloadBytes ?? 2_000,
    exportJobName: false,
  });
  return { account, screenKey };
}

function parseObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the stored screen is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some((entry) => containsNull(entry));
  if (typeof value !== "object") return false;
  return Object.values(value).some((entry) => containsNull(entry));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runCycle", () => {
  it("stores a flat polling body with the webhook wire form's null omission", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const { account } = await createAccount(store, keys);
    stubCloud();

    const result = await runCycle(
      { store, keyring: keys, ...networkDependencies },
      { account, now: NOW },
    );
    const screen = await store.readScreen(account.id);

    expect(result).toMatchObject({ kind: "rendered", cloud: "connected" });
    expect(screen).not.toBeNull();
    if (screen === null) throw new Error("the successful cycle did not store a screen");
    expect(screen.renderedAt).toBe(NOW);
    const parsed = parseObject(screen.body);
    expect(parsed.printers).toEqual([
      expect.objectContaining({ name: "Synthetic printer", progress: 42 }),
    ]);
    expect(screen.body).not.toContain('"merge_variables"');
    expect(containsNull(parsed)).toBe(false);
  });

  it("marks a refused credential without replacing the last good screen", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const { account } = await createAccount(store, keys);
    const previous = {
      body: JSON.stringify({ v: 1, printers: [] }),
      renderedAt: NOW - 5 * 60_000,
    };
    await store.writeScreen(account.id, previous);
    stubCloud({ cloudStatus: 401 });

    const result = await runCycle(
      { store, keyring: keys, ...networkDependencies },
      { account, now: NOW },
    );

    expect(result).toEqual({ kind: "reauth_required" });
    expect((await store.accountById(account.id))?.reauthRequired).toBe(true);
    expect(await store.readScreen(account.id)).toEqual(previous);
  });

  it("re-renders an unchanged poll without rate limiting", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const { account } = await createAccount(store, keys);
    const cloud = stubCloud();
    const deps = { store, keyring: keys, ...networkDependencies };

    const firstResult = await runCycle(deps, { account, now: NOW });
    const firstScreen = await store.readScreen(account.id);
    const secondResult = await runCycle(deps, {
      account,
      now: NOW + 5 * 60_000,
    });
    const secondScreen = await store.readScreen(account.id);

    expect(firstResult.kind).toBe("rendered");
    expect(secondResult.kind).toBe("rendered");
    expect(firstScreen?.body).not.toBe(secondScreen?.body);
    expect(secondScreen?.renderedAt).toBe(NOW + 5 * 60_000);
    expect(cloud.count).toBe(4);
  });

  it("does not replace a screen with a payload over its configured bound", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const { account } = await createAccount(store, keys, { maxPayloadBytes: 1 });
    const previous = {
      body: JSON.stringify({ v: 1, printers: [] }),
      renderedAt: NOW - 5 * 60_000,
    };
    await store.writeScreen(account.id, previous);
    stubCloud();

    const result = await runCycle(
      { store, keyring: keys, ...networkDependencies },
      { account, now: NOW },
    );

    expect(result).toMatchObject({
      kind: "payload_not_sendable",
      cloud: "connected",
    });
    expect(await store.readScreen(account.id)).toEqual(previous);
  });
});

describe("runDueAccounts", () => {
  it("continues after one account fails and returns one summary per account", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const badId = ["account", "bad"].join("-");
    await store.createAccount({
      id: badId,
      ownerTag: ownerTagForTest(),
      region: "global",
      token: await sealToken(keys, ["different", "account"].join("-"), TOKEN),
      deviceIds: [DEVICE_ID],
      maxPayloadBytes: 2_000,
      exportJobName: false,
    });
    const { account: goodAccount } = await createAccount(store, keys, {
      suffix: "good",
    });
    stubCloud();

    const summaries = await runDueAccounts(
      { store, keyring: keys, ...networkDependencies },
      { now: NOW },
    );

    expect(summaries).toHaveLength(2);
    expect(summaries.map((entry) => entry.result.kind)).toEqual(["failed", "rendered"]);
    expect(
      summaries.every((entry) => /^[0-9a-f]{16}$/.test(entry.accountTag)),
    ).toBe(true);
    expect(await store.readScreen(goodAccount.id)).not.toBeNull();
  });

  it("returns and stores no plaintext credential or printer identifier", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const { account, screenKey } = await createAccount(store, keys, {
      suffix: "private",
    });
    stubCloud();

    const summaries = await runDueAccounts(
      { store, keyring: keys, ...networkDependencies },
      { now: NOW },
    );
    const screen = await store.readScreen(account.id);
    expect(screen).not.toBeNull();
    if (screen === null) throw new Error("the successful batch did not store a screen");

    for (const observable of [JSON.stringify(summaries), screen.body]) {
      expect(observable).not.toContain(TOKEN);
      expect(observable).not.toContain(DEVICE_ID);
      expect(observable).not.toContain(screenKey);
      expect(observable).not.toContain(account.id);
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { sealToken, importKeyring, type Keyring } from "../src/crypto.ts";
import { networkDependencies, runCycle, runDueAccounts } from "../src/cycle.ts";
import { createLogger } from "../src/log.ts";
import { MemoryStore } from "../src/store-memory.ts";
import type { Account } from "../src/store.ts";
import { cycleLogDetail } from "../src/worker.ts";
import { DEVICE_ID, syntheticWebhookUrl } from "../../bridge/test/synthetic-values.ts";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const TOKEN = ["synthetic", "cloud", "token"].join("-");

interface StubOptions {
  cloudStatus?: number;
  pushStatus?: number;
}

function stubNetwork(options: StubOptions = {}) {
  let progress = 42;
  let pushCount = 0;
  const cloudStatus = options.cloudStatus ?? 200;
  const pushStatus = options.pushStatus ?? 200;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
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

    pushCount += 1;
    return new Response("accepted", { status: pushStatus });
  });

  return {
    pushCount: () => pushCount,
    setProgress(value: number): void {
      progress = value;
    },
  };
}

async function keyring(): Promise<Keyring> {
  const bytes = new Uint8Array(32);
  bytes.fill(7);
  const encoded = btoa(String.fromCharCode(...bytes));
  return importKeyring({ k1: encoded }, "k1");
}

async function createAccount(
  store: MemoryStore,
  keys: Keyring,
  suffix = "one",
  maxPushesPerHour = 12,
): Promise<Account> {
  const id = ["account", suffix].join("-");
  return store.createAccount({
    id,
    region: "global",
    token: await sealToken(keys, id, TOKEN),
    deviceIds: [DEVICE_ID],
    webhookUrl: syntheticWebhookUrl(),
    maxPushesPerHour,
    maxPayloadBytes: 2_000,
    exportJobName: false,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runCycle", () => {
  it("polls and pushes a changed display", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const account = await createAccount(store, keys);
    const network = stubNetwork();

    const result = await runCycle(
      { store, keyring: keys, ...networkDependencies },
      { account, now: NOW },
    );

    expect(result).toMatchObject({ kind: "pushed", reason: "changed", cloud: "connected" });
    expect(network.pushCount()).toBe(1);
    expect(await store.readPushRecord(account.id)).toMatchObject({
      recentPushes: [NOW],
      lastPushedAt: NOW,
    });
  });

  it("marks a refused cloud credential and does not push", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const account = await createAccount(store, keys);
    const network = stubNetwork({ cloudStatus: 401 });

    const result = await runCycle(
      { store, keyring: keys, ...networkDependencies },
      { account, now: NOW },
    );

    expect(result).toEqual({ kind: "reauth_required" });
    expect((await store.accountById(account.id))?.reauthRequired).toBe(true);
    expect(network.pushCount()).toBe(0);
    expect(await store.readPushRecord(account.id)).toEqual({
      recentPushes: [],
      lastSerialized: null,
      lastPushedAt: null,
    });
  });

  it("does not record a webhook refusal as a push", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const account = await createAccount(store, keys);
    const before = await store.readPushRecord(account.id);
    const network = stubNetwork({ pushStatus: 503 });

    const result = await runCycle(
      { store, keyring: keys, ...networkDependencies },
      { account, now: NOW },
    );

    expect(result).toMatchObject({ kind: "push_refused", reason: "server-error" });
    expect(network.pushCount()).toBe(1);
    expect(await store.readPushRecord(account.id)).toEqual(before);
  });

  it("skips an unchanged payload before calling the webhook", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const account = await createAccount(store, keys);
    const network = stubNetwork();
    const deps = { store, keyring: keys, ...networkDependencies };

    await runCycle(deps, { account, now: NOW });
    const result = await runCycle(deps, { account, now: NOW + 5 * 60_000 });

    expect(result).toMatchObject({ kind: "skipped", reason: "unchanged" });
    expect(network.pushCount()).toBe(1);
  });

  it("keeps the hourly ceiling in a PushRecord across cycles", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const account = await createAccount(store, keys, "limited", 2);
    const network = stubNetwork();
    const deps = { store, keyring: keys, ...networkDependencies };

    network.setProgress(10);
    expect((await runCycle(deps, { account, now: NOW })).kind).toBe("pushed");
    network.setProgress(20);
    expect((await runCycle(deps, { account, now: NOW + 30 * 60_000 })).kind).toBe("pushed");
    network.setProgress(30);
    const third = await runCycle(deps, { account, now: NOW + 35 * 60_000 });

    expect(third).toMatchObject({ kind: "skipped", reason: "rate-limited" });
    expect(network.pushCount()).toBe(2);
    expect((await store.readPushRecord(account.id)).recentPushes).toEqual([
      NOW,
      NOW + 30 * 60_000,
    ]);
  });
});

describe("runDueAccounts", () => {
  it("continues after one account cannot open its token", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const badId = ["account", "bad"].join("-");
    await store.createAccount({
      id: badId,
      region: "global",
      token: await sealToken(keys, ["different", "account"].join("-"), TOKEN),
      deviceIds: [DEVICE_ID],
      webhookUrl: syntheticWebhookUrl(),
      maxPushesPerHour: 12,
      maxPayloadBytes: 2_000,
      exportJobName: false,
    });
    await createAccount(store, keys, "good");
    const network = stubNetwork();

    const summaries = await runDueAccounts(
      { store, keyring: keys, ...networkDependencies },
      { now: NOW },
    );

    expect(summaries.map((entry) => entry.result.kind)).toEqual(["failed", "pushed"]);
    expect(network.pushCount()).toBe(1);
  });

  // Deliberately routed through `cycleLogDetail`, the same function the Worker
  // uses. An earlier version of this test built its own parallel detail object,
  // which would have kept passing after someone added a field to the real one:
  // exactly the regression it exists to catch.
  it("returns and logs no token, webhook URL or device id", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    const account = await createAccount(store, keys, "private");
    stubNetwork();
    const summaries = await runDueAccounts(
      { store, keyring: keys, ...networkDependencies },
      { now: NOW },
    );
    const lines: string[] = [];
    const logger = createLogger("info", (line) => lines.push(line));

    for (const summary of summaries) {
      logger.info("account cycle completed", cycleLogDetail(summary));
    }

    const observable = `${JSON.stringify(summaries)}\n${lines.join("\n")}`;
    expect(observable).not.toContain(TOKEN);
    expect(observable).not.toContain(account.webhookUrl);
    expect(observable).not.toContain(DEVICE_ID);
    expect(observable).not.toContain(account.id);
    expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();
  });

  // Every value the Worker logs has to be a fixed token, a number, or the
  // hashed tag. A field carrying anything else is how a credential reaches a
  // log aggregator.
  it("logs only scalars a person could not trace back to an account", async () => {
    const store = new MemoryStore();
    const keys = await keyring();
    await createAccount(store, keys, "scalars");
    stubNetwork();
    const summaries = await runDueAccounts(
      { store, keyring: keys, ...networkDependencies },
      { now: NOW },
    );

    for (const summary of summaries) {
      const detail = cycleLogDetail(summary);
      expect(Object.keys(detail).sort()).toEqual(["account_tag", "bytes", "outcome", "reason"]);
      for (const value of Object.values(detail)) {
        expect(["string", "number", "boolean", "object"]).toContain(typeof value);
        if (typeof value === "object") expect(value).toBeNull();
      }
      expect(detail.account_tag).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

import { describe, expect, it } from "vitest";
import { newAccountId, newScreenKey, screenKeyFingerprint, sealToken } from "../src/crypto.ts";
import { FRESH_FOR_MS, serveScreen } from "../src/screen.ts";
import { MemoryStore } from "../src/store-memory.ts";
import type { Account, Store } from "../src/store.ts";
import { keyringForTest, TOKEN } from "./helpers.ts";
import { unknownPrinterState } from "../../bridge/src/coordinator/merge.ts";
import { buildWebhookPayload } from "../../bridge/src/push/payload.ts";
import { DEVICE_ID } from "../../bridge/test/synthetic-values.ts";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const OPEN: { allowedAddresses: readonly string[] } = { allowedAddresses: [] };

/** The key travels in a header, never a query parameter. */
function bearer(key: string): string {
  return `Bearer ${key}`;
}

/** A rendered body in the shape the cron stores: merge variables at the root. */
function body(progress: number | null): string {
  return JSON.stringify({
    v: 1,
    updated_at: "2026-08-24T12:00Z",
    printers: [{ state: progress === null ? "idle" : "printing", name: "Bench", progress }],
    hidden: 0,
    cloud: "connected",
  });
}

async function enrol(
  store: Store,
  options: { renderedAt?: number | null; reauthRequired?: boolean } = {},
): Promise<{ account: Account; key: string }> {
  const keyring = await keyringForTest();
  const id = newAccountId();
  const key = newScreenKey();

  const account = await store.createAccount({
    id,
    region: "global",
    token: await sealToken(keyring, id, TOKEN),
    screenKeyFingerprint: await screenKeyFingerprint(key),
    deviceIds: [DEVICE_ID],
    maxPayloadBytes: 5120,
    exportJobName: false,
  });

  if (options.reauthRequired === true) await store.markReauthRequired(id);
  if (options.renderedAt !== undefined && options.renderedAt !== null) {
    await store.writeScreen(id, { body: body(42), renderedAt: options.renderedAt });
  }
  return { account, key };
}

describe("serveScreen", () => {
  it("serves a stored render for a valid key", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW });

    const outcome = await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: null, now: NOW });
    expect(outcome.kind).toBe("served");
    if (outcome.kind !== "served") throw new Error("unreachable");

    const parsed = JSON.parse(outcome.body) as Record<string, unknown>;
    // Polling wants merge variables at the root. Anything nested under
    // `merge_variables` would render as nothing at all.
    expect(parsed).not.toHaveProperty("merge_variables");
    expect(parsed.printers).toBeInstanceOf(Array);
    expect(parsed.v).toBe(1);
  });

  // The whole failure this guards is the cron having stopped. A body that
  // carried its own freshness would keep claiming to be fresh forever.
  it("adds freshness at serve time rather than trusting the render", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW - 7 * 60_000 });

    const outcome = await serveScreen(store, OPEN, {
      authorization: bearer(key),
      clientAddress: null,
      now: NOW,
    });
    if (outcome.kind !== "served") throw new Error("unreachable");

    expect(outcome.freshness).toEqual({ age_minutes: 7, fresh: true });
    const parsed = JSON.parse(outcome.body) as Record<string, unknown>;
    expect(parsed.age_minutes).toBe(7);
    expect(parsed.fresh).toBe(true);
  });

  it("calls a render stale once the cron has missed three cycles", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW - FRESH_FOR_MS - 60_000 });

    const outcome = await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: null, now: NOW });
    if (outcome.kind !== "served") throw new Error("unreachable");

    expect(outcome.freshness.fresh).toBe(false);
    expect(outcome.freshness.age_minutes).toBe(16);
  });

  it("still serves the boundary as fresh", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW - FRESH_FOR_MS });

    const outcome = await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: null, now: NOW });
    if (outcome.kind !== "served") throw new Error("unreachable");
    expect(outcome.freshness.fresh).toBe(true);
  });

  // A display saying the reading is hours old is more use to its owner than a
  // blank one, and it is the thing that prompts them to sign in again.
  it("serves an account whose token the cloud has refused", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW, reauthRequired: true });

    expect((await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: null, now: NOW })).kind).toBe(
      "served",
    );
  });

  it("never treats a clock skew as a negative age", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW + 60_000 });

    const outcome = await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: null, now: NOW });
    if (outcome.kind !== "served") throw new Error("unreachable");
    expect(outcome.freshness.age_minutes).toBe(0);
  });
});

describe("serveScreen refusals", () => {
  it("distinguishes a missing key from a wrong one, but only internally", async () => {
    const store = new MemoryStore();
    await enrol(store, { renderedAt: NOW });

    expect((await serveScreen(store, OPEN, { authorization: null, clientAddress: null, now: NOW })).kind).toBe(
      "no-key",
    );
    expect((await serveScreen(store, OPEN, { authorization: "Bearer   ", clientAddress: null, now: NOW })).kind).toBe(
      "no-key",
    );
    expect(
      (await serveScreen(store, OPEN, { authorization: bearer(newScreenKey()), clientAddress: null, now: NOW })).kind,
    ).toBe("unknown-key");
  });

  it("stops serving a key that has been rotated, and starts serving the new one", async () => {
    const store = new MemoryStore();
    const { account, key } = await enrol(store, { renderedAt: NOW });
    const replacement = newScreenKey();
    await store.replaceScreenKey(account.id, await screenKeyFingerprint(replacement));

    expect((await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: null, now: NOW })).kind).toBe(
      "unknown-key",
    );
    expect(
      (await serveScreen(store, OPEN, { authorization: bearer(replacement), clientAddress: null, now: NOW })).kind,
    ).toBe("served");
  });

  it("stops serving a deleted account", async () => {
    const store = new MemoryStore();
    const { account, key } = await enrol(store, { renderedAt: NOW });
    await store.deleteAccount(account.id);

    expect((await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: null, now: NOW })).kind).toBe(
      "unknown-key",
    );
  });

  it("says nothing has been rendered rather than serving an empty screen", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store);

    expect((await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: null, now: NOW })).kind).toBe(
      "not-rendered-yet",
    );
  });

  it("refuses a render it cannot parse instead of handing TRMNL something broken", async () => {
    const store = new MemoryStore();
    const { account, key } = await enrol(store);
    await store.writeScreen(account.id, { body: "not json", renderedAt: NOW });

    expect((await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: null, now: NOW })).kind).toBe(
      "unreadable-render",
    );
  });

  it("refuses a render that is valid JSON but not an object", async () => {
    const store = new MemoryStore();
    const { account, key } = await enrol(store);
    await store.writeScreen(account.id, { body: "[1,2,3]", renderedAt: NOW });

    expect((await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: null, now: NOW })).kind).toBe(
      "unreadable-render",
    );
  });
});

describe("the address allowlist", () => {
  const restricted = { allowedAddresses: ["203.0.113.7"] as readonly string[] };

  it("passes an allowed address", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW });

    expect(
      (await serveScreen(store, restricted, { authorization: bearer(key), clientAddress: "203.0.113.7", now: NOW })).kind,
    ).toBe("served");
  });

  it("refuses an address that is not on it", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW });

    expect(
      (await serveScreen(store, restricted, { authorization: bearer(key), clientAddress: "198.51.100.9", now: NOW })).kind,
    ).toBe("address-refused");
  });

  // An allowlist that stops applying when the platform omits a header is not an
  // allowlist.
  it("refuses an unknown address rather than waving it through", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW });

    expect(
      (await serveScreen(store, restricted, { authorization: bearer(key), clientAddress: null, now: NOW })).kind,
    ).toBe("address-refused");
  });

  it("checks the address before the key, so a refused caller learns nothing", async () => {
    const store = new MemoryStore();
    await enrol(store, { renderedAt: NOW });

    expect(
      (
        await serveScreen(store, restricted, {
          authorization: bearer(newScreenKey()),
          clientAddress: "198.51.100.9",
          now: NOW,
        })
      ).kind,
    ).toBe("address-refused");
  });

  it("is unrestricted when empty, which is the shipped default", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW });

    expect(
      (await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: "198.51.100.9", now: NOW })).kind,
    ).toBe("served");
  });
});

describe("what a served screen cannot contain", () => {
  it("carries no token, device id, account id or screen key", async () => {
    const store = new MemoryStore();
    const { account, key } = await enrol(store, { renderedAt: NOW });

    const outcome = await serveScreen(store, OPEN, { authorization: bearer(key), clientAddress: null, now: NOW });
    if (outcome.kind !== "served") throw new Error("unreachable");

    const observable = `${outcome.body}\n${JSON.stringify(outcome)}`;
    expect(observable).not.toContain(TOKEN);
    expect(observable).not.toContain(DEVICE_ID);
    expect(observable).not.toContain(account.id);
    expect(observable).not.toContain(key);
    expect(observable).not.toContain(account.screenKeyFingerprint);
  });
});

// `screen.ts` spreads freshness over the stored body, so a root-level
// `age_minutes` or `fresh` from the payload builder would be silently
// overwritten. There is no collision today, and this is what makes that a fact
// rather than a coincidence nobody is watching.
describe("the freshness keys cannot collide with the payload", () => {
  it("is not a key the payload builder emits", () => {
    const built = buildWebhookPayload(
      [
        {
          printerKey: DEVICE_ID,
          state: unknownPrinterState("2026-08-24T12:00Z"),
          provenance: {},
        },
      ],
      { now: NOW, cloud: "connected", maxBytes: 5120, exportJobName: false },
    );

    expect(Object.keys(built.variables)).not.toContain("age_minutes");
    expect(Object.keys(built.variables)).not.toContain("fresh");
  });
});

import { describe, expect, it } from "vitest";
import { newAccountId, newScreenKey, screenKeyFingerprint, sealToken } from "../src/crypto.ts";
import { FRESH_FOR_MS, serveScreen, type RateLimiter } from "../src/screen.ts";
import { MemoryStore } from "../src/store-memory.ts";
import type { Account, Store } from "../src/store.ts";
import { keyringForTest, ownerTagForTest, TOKEN } from "./helpers.ts";
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
    ownerTag: ownerTagForTest(),
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

/** A limiter that allows a fixed number of calls, then refuses, recording keys. */
function limiterAllowing(count: number): RateLimiter & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success: keys.length <= count };
    },
  };
}

describe("rate limiting", () => {
  // Stronger than counting queries: a store whose every method throws proves
  // the shape check refuses before anything touches the database at all.
  it("does not touch the database for a key that cannot be one of ours", async () => {
    const refusing = new Proxy({} as Store, {
      get: () => () => {
        throw new Error("the database must not be reached for a malformed key");
      },
    });

    const outcome = await serveScreen(refusing, OPEN, {
      authorization: bearer("obviously-not-a-key"),
      clientAddress: "198.51.100.9",
      now: NOW,
    });

    expect(outcome.kind).toBe("unknown-key");
  });

  it("refuses a malformed key exactly as it refuses an unknown one", async () => {
    const store = new MemoryStore();
    await enrol(store, { renderedAt: NOW });

    for (const candidate of ["short", "!".repeat(43), `${newScreenKey()}x`]) {
      const outcome = await serveScreen(store, OPEN, {
        authorization: bearer(candidate),
        clientAddress: null,
        now: NOW,
      });
      expect(outcome.kind).toBe("unknown-key");
    }
  });

  it("refuses before the lookup, so a rejected request costs no query", async () => {
    let lookups = 0;
    const counting = new Proxy({} as Store, {
      get: (_target, name) => {
        if (name === "pollByScreenKey") {
          return () => {
            lookups += 1;
            return Promise.resolve(null);
          };
        }
        throw new Error(`unexpected store call: ${String(name)}`);
      },
    });
    const addressLimiter = limiterAllowing(3);
    const policy = { allowedAddresses: [] as readonly string[], addressLimiter };

    const seen: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const outcome = await serveScreen(counting, policy, {
        // A different well-formed key each time, which is what a guessing
        // attack looks like. The shape check cannot stop these.
        authorization: bearer(newScreenKey()),
        clientAddress: "198.51.100.9",
        now: NOW,
      });
      seen.push(outcome.kind);
    }

    expect(seen).toEqual([
      "unknown-key",
      "unknown-key",
      "unknown-key",
      "address-limited",
      "address-limited",
      "address-limited",
    ]);
    // The ceiling has to bound the expensive thing. Three allowed, three
    // refused, and only the allowed three reached Postgres.
    expect(lookups).toBe(3);
    expect(new Set(addressLimiter.keys)).toEqual(new Set(["198.51.100.9"]));
  });

  // The allowlist is how TRMNL is exempted, rather than guessing a limit its
  // traffic will never reach. If this breaks, TRMNL gets throttled at scale.
  it("never counts an allowlisted caller", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW });
    const addressLimiter = limiterAllowing(0);

    const outcome = await serveScreen(
      store,
      { allowedAddresses: ["203.0.113.7"], addressLimiter },
      { authorization: bearer(key), clientAddress: "203.0.113.7", now: NOW },
    );

    expect(outcome.kind).toBe("served");
    expect(addressLimiter.keys).toEqual([]);
  });

  it("counts a resolved request against that account's fingerprint", async () => {
    const store = new MemoryStore();
    const { account, key } = await enrol(store, { renderedAt: NOW });
    const accountLimiter = limiterAllowing(1);
    const policy = { allowedAddresses: [] as readonly string[], accountLimiter };
    const request = { authorization: bearer(key), clientAddress: null, now: NOW };

    expect((await serveScreen(store, policy, request)).kind).toBe("served");
    expect((await serveScreen(store, policy, request)).kind).toBe("account-limited");
    // The fingerprint, never the bearer key: a platform counter must not see it.
    expect(accountLimiter.keys).toEqual([
      account.screenKeyFingerprint,
      account.screenKeyFingerprint,
    ]);
    expect(accountLimiter.keys).not.toContain(key);
  });

  it("shares one counter when the platform gives no address", async () => {
    const store = new MemoryStore();
    const addressLimiter = limiterAllowing(5);

    await serveScreen(
      store,
      { allowedAddresses: [], addressLimiter },
      { authorization: bearer(newScreenKey()), clientAddress: null, now: NOW },
    );
    // Never an empty key, which would silently escape the ceiling entirely.
    expect(addressLimiter.keys).toEqual(["unknown-address"]);
  });

  // A volume guard is not authentication. Failing closed on a limiter fault
  // would blank every customer's display, turning an abuse control into an
  // outage.
  it("serves the screen when the limiter itself fails", async () => {
    const store = new MemoryStore();
    const { key } = await enrol(store, { renderedAt: NOW });
    const broken: RateLimiter = {
      limit: () => Promise.reject(new Error("limiter unavailable")),
    };

    const outcome = await serveScreen(
      store,
      { allowedAddresses: [], addressLimiter: broken, accountLimiter: broken },
      { authorization: bearer(key), clientAddress: "203.0.113.7", now: NOW },
    );
    expect(outcome.kind).toBe("served");
  });

  it("applies no limit at all when none is configured", async () => {
    const store = new MemoryStore();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const outcome = await serveScreen(store, OPEN, {
        authorization: bearer(newScreenKey()),
        clientAddress: "198.51.100.9",
        now: NOW,
      });
      expect(outcome.kind).toBe("unknown-key");
    }
  });
});

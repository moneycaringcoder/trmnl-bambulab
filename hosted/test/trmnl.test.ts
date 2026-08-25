/**
 * The TRMNL third-party plugin protocol, driven with TRMNL's documented shapes.
 *
 * Every request body and parameter here is copied from TRMNL's marketplace
 * documentation (plugin-installation-flow, plugin-screen-generation-flow):
 * the single-use `code`, the 200-with-error token response, the success webhook
 * body with `user.uuid` and `user.plugin_setting_id`, and the Bearer-token
 * markup request answered with the four layout keys.
 */

import { describe, expect, it } from "vitest";
import { importKeyringFromEnv, sealToken, type Keyring } from "../src/crypto.ts";
import { MemoryStore } from "../src/store-memory.ts";
import {
  identifyInstallation,
  install,
  markup,
  recordInstallSuccess,
  signManageToken,
  uninstall,
  verifyManageToken,
  MANAGE_TOKEN_TTL_MS,
  type TrmnlPorts,
} from "../src/trmnl.ts";

/** A real keyring over a generated key; nothing here is pasted. */
async function testKeyring(): Promise<Keyring> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return await importKeyringFromEnv({
    TOKEN_KEY_K1: btoa(binary),
    TOKEN_KEY_CURRENT_ID: "k1",
  });
}

interface Harness {
  ports: TrmnlPorts;
  store: MemoryStore;
  keyring: Keyring;
  /** What the fake TRMNL token endpoint answers, keyed by code. */
  tokensByCode: Map<string, string>;
  exchanges: string[];
}

async function harness(): Promise<Harness> {
  const keyring = await testKeyring();
  const store = new MemoryStore();
  const tokensByCode = new Map<string, string>();
  const exchanges: string[] = [];
  const ports: TrmnlPorts = {
    store,
    keyring,
    async exchangeCode(code) {
      exchanges.push(code);
      const token = tokensByCode.get(code);
      // TRMNL answers 200 with `{ "error": true }` for a spent or unknown
      // code; the port maps that to a refusal.
      return token === undefined ? { ok: false } : { ok: true, accessToken: token };
    },
    now: () => 1_000_000,
  };
  return { ports, store, keyring, tokensByCode, exchanges };
}

const bearer = (token: string) => `Bearer ${token}`;

describe("installation", () => {
  it("exchanges the code and mints a management token", async () => {
    const test = await harness();
    test.tokensByCode.set("abc123", "a1b2c3d4e5f6");

    const outcome = await install(test.ports, "abc123");
    if (outcome.kind !== "installed") throw new Error("expected an installation");

    // The management token proves the installation to the setup page.
    const installation = await verifyManageToken(
      test.keyring,
      test.store,
      outcome.manageToken,
      1_000_000,
    );
    expect(installation).not.toBeNull();
    // And TRMNL's own token authenticates its future requests.
    const byToken = await identifyInstallation(test.ports, bearer("a1b2c3d4e5f6"));
    expect(byToken?.id).toBe(installation?.id);
  });

  it("refuses a spent or unknown code, the way TRMNL reports one", async () => {
    const test = await harness();
    const outcome = await install(test.ports, "expired-code");
    expect(outcome.kind).toBe("refused");
  });

  it("refuses an empty code without asking TRMNL", async () => {
    const test = await harness();
    const outcome = await install(test.ports, "   ");
    expect(outcome.kind).toBe("refused");
    expect(test.exchanges).toEqual([]);
  });

  it("maps a second install of the same token onto the existing row", async () => {
    const test = await harness();
    test.tokensByCode.set("first", "same-token");
    test.tokensByCode.set("second", "same-token");

    const first = await install(test.ports, "first");
    const second = await install(test.ports, "second");
    if (first.kind !== "installed" || second.kind !== "installed") {
      throw new Error("expected two installs");
    }
    const a = await verifyManageToken(test.keyring, test.store, first.manageToken, 1_000_000);
    const b = await verifyManageToken(test.keyring, test.store, second.manageToken, 1_000_000);
    // One person pressing install twice is one installation, not two.
    expect(a?.id).toBe(b?.id);
  });

  it("never stores the access token itself", async () => {
    const test = await harness();
    test.tokensByCode.set("abc123", "the-live-credential");
    await install(test.ports, "abc123");

    const installation = await identifyInstallation(test.ports, bearer("the-live-credential"));
    expect(installation).not.toBeNull();
    // The stored tag must not contain or equal the credential.
    expect(installation?.accessTokenTag).not.toContain("the-live-credential");
  });
});

describe("the management token", () => {
  it("expires", async () => {
    const test = await harness();
    test.tokensByCode.set("abc123", "tok");
    const outcome = await install(test.ports, "abc123");
    if (outcome.kind !== "installed") throw new Error("expected an installation");

    const late = 1_000_000 + MANAGE_TOKEN_TTL_MS + 1;
    expect(await verifyManageToken(test.keyring, test.store, outcome.manageToken, late)).toBeNull();
  });

  it("refuses a forged or tampered token", async () => {
    const test = await harness();
    test.tokensByCode.set("abc123", "tok");
    const outcome = await install(test.ports, "abc123");
    if (outcome.kind !== "installed") throw new Error("expected an installation");

    const [id, expiry, mac] = outcome.manageToken.split(".") as [string, string, string];
    // A different installation id under the same signature must fail.
    const forgedId = await verifyManageToken(
      test.keyring,
      test.store,
      `${crypto.randomUUID()}.${expiry}.${mac}`,
      1_000_000,
    );
    expect(forgedId).toBeNull();
    // A pushed-out expiry must fail: the expiry is signed.
    const forgedExpiry = await verifyManageToken(
      test.keyring,
      test.store,
      `${id}.${Number(expiry) + 60_000}.${mac}`,
      1_000_000,
    );
    expect(forgedExpiry).toBeNull();
    expect(await verifyManageToken(test.keyring, test.store, "garbage", 1_000_000)).toBeNull();
  });

  it("can be re-minted for a live installation", async () => {
    const test = await harness();
    test.tokensByCode.set("abc123", "tok");
    const outcome = await install(test.ports, "abc123");
    if (outcome.kind !== "installed") throw new Error("expected an installation");
    const installation = await verifyManageToken(
      test.keyring,
      test.store,
      outcome.manageToken,
      1_000_000,
    );

    const fresh = await signManageToken(test.keyring, installation?.id ?? "", 2_000_000);
    const verified = await verifyManageToken(test.keyring, test.store, fresh, 2_000_000);
    expect(verified?.id).toBe(installation?.id);
  });
});

describe("the success webhook", () => {
  // The documented body, with the fields we deliberately drop included.
  const documentedBody = (uuid: string) => ({
    user: {
      id: 5678,
      name: "Test User",
      email: "user@example.com",
      first_name: "Test",
      last_name: "User",
      locale: "en",
      time_zone: "Pacific Time (US & Canada)",
      time_zone_iana: "America/Los_Angeles",
      utc_offset: -28800,
      plugin_setting_id: 1234,
      uuid,
    },
  });

  it("records the uuid and settings id from the documented body", async () => {
    const test = await harness();
    test.tokensByCode.set("abc123", "tok");
    await install(test.ports, "abc123");

    const uuid = crypto.randomUUID();
    const result = await recordInstallSuccess(test.ports, bearer("tok"), documentedBody(uuid));
    expect(result).toBe("done");

    const installation = await identifyInstallation(test.ports, bearer("tok"));
    expect(installation?.userUuid).toBe(uuid);
    expect(installation?.pluginSettingId).toBe(1234);
  });

  it("refuses a webhook with no or an unknown token", async () => {
    const test = await harness();
    expect(await recordInstallSuccess(test.ports, null, documentedBody("x"))).toBe(
      "unauthenticated",
    );
    expect(
      await recordInstallSuccess(test.ports, bearer("unknown"), documentedBody("x")),
    ).toBe("unauthenticated");
  });

  it("refuses a body without a uuid", async () => {
    const test = await harness();
    test.tokensByCode.set("abc123", "tok");
    await install(test.ports, "abc123");
    expect(await recordInstallSuccess(test.ports, bearer("tok"), { user: {} })).toBe("invalid");
    expect(await recordInstallSuccess(test.ports, bearer("tok"), null)).toBe("invalid");
  });
});

describe("markup", () => {
  /** Installs, enrols an account, and stores a rendered screen. */
  async function installedWithScreen(test: Harness, body: string) {
    test.tokensByCode.set("abc123", "tok");
    await install(test.ports, "abc123");
    const installation = await identifyInstallation(test.ports, bearer("tok"));
    if (installation === null) throw new Error("expected an installation");

    const account = await test.store.createAccount({
      id: crypto.randomUUID(),
      ownerTag: "f".repeat(64),
      region: "global",
      token: await sealToken(test.keyring, "acct", "not-a-real-token"),
      deviceIds: [`${"0".repeat(12)}A1`],
      maxPayloadBytes: 2048,
      exportJobName: false,
    });
    await test.store.linkInstallationAccount(installation.id, account.id);
    await test.store.writeScreen(account.id, { body, renderedAt: 999_000 });
    return account;
  }

  const storedRender = JSON.stringify({
    v: 1,
    updated_at: "12:00 UTC",
    printers: [
      {
        state: "printing",
        raw_state: "RUNNING",
        name: "Workshop",
        online: true,
        stale: false,
        progress: 42,
        layer: 81,
        layers: 194,
        remaining: "1h 16m",
        nozzle: 220,
        bed: 60,
      },
    ],
    hidden: 0,
    cloud: "connected",
  });

  it("answers a Bearer-authenticated request with all four layouts", async () => {
    const test = await harness();
    await installedWithScreen(test, storedRender);

    const outcome = await markup(test.ports, bearer("tok"));
    if (outcome.kind !== "markup") throw new Error("expected markup");

    for (const key of [
      "markup",
      "markup_half_horizontal",
      "markup_half_vertical",
      "markup_quadrant",
    ] as const) {
      expect(outcome.markup[key].length).toBeGreaterThan(0);
    }
    // The full layout carries the real figures, rendered from our templates.
    expect(outcome.markup.markup).toContain("42%");
    expect(outcome.markup.markup).toContain("Workshop");
  });

  it("refuses a missing, malformed and unknown token identically", async () => {
    const test = await harness();
    await installedWithScreen(test, storedRender);

    for (const authorization of [null, "Basic abc", bearer("wrong")]) {
      const outcome = await markup(test.ports, authorization);
      expect(outcome.kind).toBe("unauthenticated");
    }
  });

  it("tells an installed-but-unenrolled user what to do, rather than erroring", async () => {
    const test = await harness();
    test.tokensByCode.set("abc123", "tok");
    await install(test.ports, "abc123");

    const outcome = await markup(test.ports, bearer("tok"));
    if (outcome.kind !== "markup") throw new Error("expected markup");
    expect(outcome.markup.markup).toContain("Not set up");
    expect(outcome.markup.markup_quadrant).toContain("view--quadrant");
  });

  it("says the first reading is coming when nothing is rendered yet", async () => {
    const test = await harness();
    test.tokensByCode.set("abc123", "tok");
    await install(test.ports, "abc123");
    const installation = await identifyInstallation(test.ports, bearer("tok"));
    const account = await test.store.createAccount({
      id: crypto.randomUUID(),
      ownerTag: "e".repeat(64),
      region: "global",
      token: await sealToken(test.keyring, "acct2", "not-a-real-token"),
      deviceIds: [],
      maxPayloadBytes: 2048,
      exportJobName: false,
    });
    await test.store.linkInstallationAccount(installation?.id ?? "", account.id);

    const outcome = await markup(test.ports, bearer("tok"));
    if (outcome.kind !== "markup") throw new Error("expected markup");
    expect(outcome.markup.markup).toContain("Waiting");
  });

  it("survives a malformed stored render", async () => {
    const test = await harness();
    await installedWithScreen(test, "not json at all");

    const outcome = await markup(test.ports, bearer("tok"));
    if (outcome.kind !== "markup") throw new Error("expected markup");
    // Something readable, never a stack trace on an e-paper display.
    expect(outcome.markup.markup).toContain("view--full");
  });
});

describe("uninstall", () => {
  it("deletes the account, its screen, and the installation", async () => {
    const test = await harness();
    test.tokensByCode.set("abc123", "tok");
    await install(test.ports, "abc123");
    const installation = await identifyInstallation(test.ports, bearer("tok"));
    const account = await test.store.createAccount({
      id: crypto.randomUUID(),
      ownerTag: "d".repeat(64),
      region: "global",
      token: await sealToken(test.keyring, "acct3", "not-a-real-token"),
      deviceIds: [`${"0".repeat(12)}A1`],
      maxPayloadBytes: 2048,
      exportJobName: false,
    });
    await test.store.linkInstallationAccount(installation?.id ?? "", account.id);
    await test.store.writeScreen(account.id, { body: "{}", renderedAt: 1 });

    expect(await uninstall(test.ports, bearer("tok"))).toBe("done");

    // Deletion actually deletes: account, screen, installation, token tag.
    expect(await test.store.accountById(account.id)).toBeNull();
    expect(await test.store.readScreen(account.id)).toBeNull();
    expect(await identifyInstallation(test.ports, bearer("tok"))).toBeNull();
  });

  it("uninstalls an unenrolled installation without error", async () => {
    const test = await harness();
    test.tokensByCode.set("abc123", "tok");
    await install(test.ports, "abc123");
    expect(await uninstall(test.ports, bearer("tok"))).toBe("done");
    expect(await identifyInstallation(test.ports, bearer("tok"))).toBeNull();
  });

  it("refuses an unauthenticated uninstall", async () => {
    const test = await harness();
    expect(await uninstall(test.ports, null)).toBe("unauthenticated");
    expect(await uninstall(test.ports, bearer("unknown"))).toBe("unauthenticated");
  });
});

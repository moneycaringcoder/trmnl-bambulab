/**
 * The authenticated surface.
 *
 * Every test here goes through a real HMAC-signed management token bound to a
 * real installation row, because the property that matters most on this surface
 * is that a caller without an installation cannot reach an account. A fake
 * identify step would make that property untestable and every one of these
 * tests would still pass.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { importKeyring, openToken, type Keyring } from "@trmnl-bambulab/core/hosted/crypto";
import type { DiscoveredPrinter } from "../src/enrol.ts";
import {
  deleteAccount,
  getAccount,
  getPrinters,
  postPrinters,
  postSession,
  postSignInCode,
  type EnrolPorts,
  type RouteResult,
} from "../src/routes.ts";
import type { RateLimiter } from "../src/limits.ts";
import {
  identifyInstallation,
  install,
  installationOwnerTags,
  signManageToken,
  MANAGE_TOKEN_TTL_MS,
  type TrmnlPorts,
} from "../src/trmnl.ts";
import { MemoryStore } from "@trmnl-bambulab/core/hosted/store-memory";
import type { Account, Region } from "@trmnl-bambulab/core/hosted/store";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const EMAIL = "owner@example.com";
const CODE = "418418";
/** Two printers, with serial-shaped ids assembled at runtime, never pasted. */
function printerFixtures(): DiscoveredPrinter[] {
  const serial = (suffix: string) => `${"0".repeat(8)}${suffix}`;
  return [
    { deviceId: serial("AAA"), name: "Workshop", online: true, model: "N2S" },
    { deviceId: serial("BBB"), name: "Spare", online: false, model: "N1" },
  ];
}

interface Harness {
  ports: EnrolPorts;
  store: MemoryStore;
  keyring: Keyring;
  auth: string;
  otherAuth: string;
  printers: DiscoveredPrinter[];
  sent: { region: Region; email: string }[];
  completed: { region: Region; email: string; code: string }[];
  /** Fails the next Bambu call with this outcome. */
  failWith(failure: { kind: "refused" | "cloud-unavailable" | "no-printers" }): void;
  listFails(kind?: "refused" | "cloud-unavailable"): void;
}

/**
 * Installs the plugin the way the real handshake does, and returns the Bearer
 * value the setup page would hold.
 */
async function installFor(
  store: MemoryStore,
  keyring: Keyring,
  accessToken: string,
): Promise<string> {
  const ports: TrmnlPorts = {
    store,
    keyring,
    async exchangeCode() {
      return { ok: true, accessToken };
    },
    now: () => NOW,
  };
  const outcome = await install(ports, "code");
  if (outcome.kind !== "installed") throw new Error("install failed in the harness");
  return `Bearer ${outcome.manageToken}`;
}

async function harness(options: { limiter?: RateLimiter } = {}): Promise<Harness> {
  const store = new MemoryStore();
  const keyring = await importKeyring({ k1: await generateKeyBase64() }, "k1");

  const printers = printerFixtures();
  const sent: { region: Region; email: string }[] = [];
  const completed: { region: Region; email: string; code: string }[] = [];
  let nextFailure: { kind: "refused" | "cloud-unavailable" | "no-printers" } | null = null;
  let listFailure: "refused" | "cloud-unavailable" | null = null;

  const ports: EnrolPorts = {
    store,
    keyring,
    // Always supplied, because the type requires it: a route whose only abuse
    // bound could be omitted is the shape the production type now forbids.
    limiter: options.limiter ?? { async limit() { return { success: true }; } },
    async requestSignInCode(region, email) {
      sent.push({ region, email });
      if (nextFailure !== null) {
        const failure = { ...nextFailure, guidance: "g" };
        nextFailure = null;
        return { ok: false, failure };
      }
      return { ok: true };
    },
    async completeSignIn(region, email, code) {
      completed.push({ region, email, code });
      if (nextFailure !== null) {
        const failure = { ...nextFailure, guidance: "g" };
        nextFailure = null;
        return { ok: false, failure };
      }
      return { ok: true, accessToken: `cloud-token-${completed.length}`, printers };
    },
    async printersFor() {
      if (listFailure !== null) {
        const failure = { kind: listFailure, guidance: "safe guidance" };
        listFailure = null;
        return { ok: false, failure };
      }
      return { ok: true, printers };
    },
    now: NOW,
  };

  return {
    ports,
    store,
    keyring,
    auth: await installFor(store, keyring, "trmnl-token-one"),
    otherAuth: await installFor(store, keyring, "trmnl-token-two"),
    printers,
    sent,
    completed,
    failWith(failure) {
      nextFailure = failure;
    },
    listFails(kind = "cloud-unavailable") {
      listFailure = kind;
    },
  };
}

/** A 32-byte key, base64, generated rather than pasted. */
async function generateKeyBase64(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Runs the whole flow and returns the stored account, via the installation link. */
async function enrolFully(h: Harness): Promise<{ account: Account }> {
  await postSignInCode(h.ports, h.auth, { region: "global", email: EMAIL });
  await postSession(h.ports, h.auth, { region: "global", email: EMAIL, code: CODE });
  const done = await postPrinters(h.ports, h.auth, {
    deviceIds: [h.printers[0]?.deviceId],
  });
  if (done.kind !== "done") throw new Error(`enrolment failed: ${done.kind}`);

  // The account must now be reachable the way the markup route reaches it:
  // through the installation's own link, not through any tag fallback.
  const trmnlPorts: TrmnlPorts = {
    store: h.store,
    keyring: h.keyring,
    async exchangeCode() {
      return { ok: false };
    },
    now: () => NOW,
  };
  const installation = await identifyInstallation(trmnlPorts, "Bearer trmnl-token-one");
  if (installation?.accountId == null) throw new Error("printers did not link the account");
  const account = await h.store.accountById(installation.accountId);
  if (account === null) throw new Error("the linked account does not exist");
  return { account };
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

describe("the whole flow", () => {
  it("signs in, lists printers, and links the installation", async () => {
    const asked = await postSignInCode(h.ports, h.auth, { region: "global", email: EMAIL });
    expect(asked).toEqual({ kind: "done" });
    expect(h.sent).toEqual([{ region: "global", email: EMAIL }]);

    const session = await postSession(h.ports, h.auth, {
      region: "global",
      email: EMAIL,
      code: CODE,
    });
    if (session.kind !== "printers") throw new Error("sign-in did not return printers");
    expect(session.printers.map((printer) => printer.name)).toEqual(["Workshop", "Spare"]);

    const listed = await getPrinters(h.ports, h.auth);
    if (listed.kind !== "printers") throw new Error("stored token did not list printers");
    expect(listed.printers.map((printer) => printer.name)).toEqual(["Workshop", "Spare"]);

    const done = await postPrinters(h.ports, h.auth, {
      deviceIds: [h.printers[1]?.deviceId],
    });
    expect(done).toEqual({ kind: "done" });

    // The chosen printer is the one stored, reachable through the installation
    // exactly the way the markup route will reach it.
    const shown = await getAccount(h.ports, h.auth);
    if (shown.kind !== "account") throw new Error("the account is not readable");
    expect(shown.deviceIds).toEqual([h.printers[1]?.deviceId]);
  });

  it("stores the cloud token sealed, and can open it again", async () => {
    const { account } = await enrolFully(h);

    // The regression this pins: an earlier version computed the sealed token and
    // never wrote it, so enrolment "succeeded" with an account the cron could
    // not use.
    expect(account.token.ciphertext.length).toBeGreaterThan(0);
    await expect(openToken(h.keyring, account.id, account.token)).resolves.toBe("cloud-token-1");
  });

  it("keeps one account per installation across repeated sign-ins", async () => {
    const first = await enrolFully(h);
    await postSession(h.ports, h.auth, { region: "global", email: EMAIL, code: CODE });
    const again = await postPrinters(h.ports, h.auth, {
      deviceIds: [h.printers[0]?.deviceId],
    });
    expect(again).toEqual({ kind: "done" });

    const second = await enrolFully(h);
    // Rotation of the choice, not accumulation of accounts.
    expect(second.account.id).toBe(first.account.id);
  });

  it("re-authenticating replaces the token and clears the refusal flag", async () => {
    const { account } = await enrolFully(h);
    await h.store.markReauthRequired(account.id);
    expect((await h.store.accountById(account.id))?.reauthRequired).toBe(true);

    await postSession(h.ports, h.auth, { region: "global", email: EMAIL, code: CODE });

    const after = await h.store.accountById(account.id);
    expect(after?.reauthRequired).toBe(false);
    await expect(openToken(h.keyring, account.id, after?.token ?? account.token)).resolves.toBe(
      "cloud-token-2",
    );
  });
});

describe("authentication", () => {
  // The property the whole surface rests on. Each route is listed explicitly
  // rather than looped over a registry, so adding a route without adding it here
  // is visible in review.
  it("refuses every route without a valid session", async () => {
    const { account } = await enrolFully(h);
    const body = { region: "global", email: EMAIL, code: CODE, deviceIds: [] };

    for (const header of [null, "", "Bearer nonsense", "Basic abc"]) {
      const results: RouteResult[] = [
        await postSignInCode(h.ports, header, body),
        await postSession(h.ports, header, body),
        await postPrinters(h.ports, header, body),
        await getPrinters(h.ports, header),
        await getAccount(h.ports, header),
        await deleteAccount(h.ports, header),
      ];
      for (const result of results) expect(result.kind).toBe("unauthenticated");
    }

    // Nothing was touched by any of that.
    expect(await h.store.accountById(account.id)).not.toBeNull();
  });

  it("refuses an expired management token", async () => {
    await enrolFully(h);
    // Signed by the real signer, for a moment already long past.
    const expired = await signManageToken(h.keyring, "some-id", NOW - MANAGE_TOKEN_TTL_MS * 2);
    expect((await getAccount(h.ports, `Bearer ${expired}`)).kind).toBe("unauthenticated");
  });

  // One installation must not be able to read or change another's account.
  it("keeps two installations separate", async () => {
    const mine = await enrolFully(h);

    expect((await getAccount(h.ports, h.otherAuth)).kind).toBe("no-account");
    expect((await getPrinters(h.ports, h.otherAuth)).kind).toBe("no-account");
    expect((await deleteAccount(h.ports, h.otherAuth)).kind).toBe("no-account");

    // Mine is untouched.
    expect(await h.store.accountById(mine.account.id)).not.toBeNull();
  });
});

describe("what a route will not say", () => {
  // Whether an address has a Bambu account is not ours to disclose. A route that
  // reported Bambu's refusal would be a way to test addresses against Bambu.
  it("answers a refused address exactly as an accepted one", async () => {
    const accepted = await postSignInCode(h.ports, h.auth, { region: "global", email: EMAIL });
    h.failWith({ kind: "refused" });
    const refused = await postSignInCode(h.ports, h.auth, {
      region: "global",
      email: "unknown@example.com",
    });

    expect(refused).toEqual(accepted);
  });

  // But a real outage is worth reporting, because retrying is the right advice
  // and silence would look like success.
  it("does report that Bambu is unreachable", async () => {
    h.failWith({ kind: "cloud-unavailable" });
    const result = await postSignInCode(h.ports, h.auth, { region: "global", email: EMAIL });

    expect(result.kind).toBe("upstream");
  });

  it("never returns a cloud token or an owner tag", async () => {
    const asked = await postSignInCode(h.ports, h.auth, { region: "global", email: EMAIL });
    const session = await postSession(h.ports, h.auth, {
      region: "global",
      email: EMAIL,
      code: CODE,
    });
    const printers = await getPrinters(h.ports, h.auth);
    const issued = await postPrinters(h.ports, h.auth, {
      deviceIds: [h.printers[0]?.deviceId],
    });
    const account = await getAccount(h.ports, h.auth);
    const tags = await installationOwnerTags(h.keyring, "any-installation");
    const tag = tags[0] ?? "";

    for (const result of [asked, session, printers, issued, account]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("cloud-token");
      expect(serialized).not.toContain(tag);
    }
  });
});

describe("input", () => {
  it("refuses a region it does not recognise", async () => {
    for (const region of ["", "eu", "GLOBAL", null, 1]) {
      const result = await postSignInCode(h.ports, h.auth, { region, email: EMAIL });
      expect(result.kind).toBe("invalid");
    }
    // An unrecognised region would point the sign-in at a host we never meant to
    // talk to, so nothing was sent.
    expect(h.sent).toEqual([]);
  });

  it("refuses a code that is not a code", async () => {
    for (const code of ["", "abcdef", "12", "1".repeat(11), " 1234 5 ", null]) {
      const result = await postSession(h.ports, h.auth, {
        region: "global",
        email: EMAIL,
        code,
      });
      expect(result.kind).toBe("invalid");
    }
    expect(h.completed).toEqual([]);
  });

  it("refuses a body that is not an object", async () => {
    for (const body of [null, "string", 42, ["array"]]) {
      expect((await postSignInCode(h.ports, h.auth, body)).kind).toBe("invalid");
    }
  });

  it("refuses to switch region on an existing account", async () => {
    await enrolFully(h);
    const result = await postSession(h.ports, h.auth, {
      region: "china",
      email: EMAIL,
      code: CODE,
    });

    // Silently keeping the old region would leave a token minted for a host it
    // will never be presented to.
    expect(result.kind).toBe("invalid");
    expect(h.completed.length).toBe(1);
  });
});

describe("the printer picker", () => {
  it("refuses a printer the account does not have", async () => {
    await postSession(h.ports, h.auth, { region: "global", email: EMAIL, code: CODE });
    const result = await postPrinters(h.ports, h.auth, { deviceIds: ["not-a-real-device"] });

    expect(result.kind).toBe("invalid");
  });

  it("checks the choice against Bambu rather than against the request", async () => {
    await postSession(h.ports, h.auth, { region: "global", email: EMAIL, code: CODE });
    h.listFails();

    // With no trustworthy list of what exists, the only honest answer is that we
    // could not check — never to accept the browser's word for it.
    expect((await postPrinters(h.ports, h.auth, { deviceIds: ["anything"] })).kind).toBe("upstream");
  });

  it("rejects more than three distinct known printers instead of truncating", async () => {
    const many: DiscoveredPrinter[] = Array.from({ length: 4 }, (_unused, index) => ({
      deviceId: `${"0".repeat(8)}${index}`,
      name: `Printer ${index}`,
      online: true,
      model: null,
    }));
    const wide = await harness();
    wide.printers.length = 0;
    wide.printers.push(...many);

    await postSession(wide.ports, wide.auth, { region: "global", email: EMAIL, code: CODE });
    const refused = await postPrinters(wide.ports, wide.auth, {
      deviceIds: [
        many[0]!.deviceId,
        many[1]!.deviceId,
        many[0]!.deviceId,
        many[2]!.deviceId,
        many[3]!.deviceId,
      ],
    });
    expect(refused).toEqual({
      kind: "invalid",
      guidance: "Choose no more than 3 printers.",
    });

    const shown = await getAccount(wide.ports, wide.auth);
    if (shown.kind !== "account") throw new Error("the account is not readable");
    expect(shown.deviceIds).toEqual([]);
  });

  it("stores the visible lead order exactly", async () => {
    const third: DiscoveredPrinter = {
      deviceId: `${"0".repeat(8)}CCC`,
      name: "Third",
      online: true,
      model: null,
    };
    h.printers.push(third);
    await postSession(h.ports, h.auth, { region: "global", email: EMAIL, code: CODE });
    const order = [third.deviceId, h.printers[0]!.deviceId, h.printers[1]!.deviceId];

    expect(await postPrinters(h.ports, h.auth, { deviceIds: order })).toEqual({ kind: "done" });
    const shown = await getAccount(h.ports, h.auth);
    if (shown.kind !== "account") throw new Error("the account is not readable");
    expect(shown.deviceIds).toEqual(order);
  });

  it("asks for a new code only when the saved token is refused", async () => {
    const { account } = await enrolFully(h);

    h.listFails("cloud-unavailable");
    expect((await getPrinters(h.ports, h.auth)).kind).toBe("upstream");
    expect((await h.store.accountById(account.id))?.reauthRequired).toBe(false);

    h.listFails("refused");
    expect(await getPrinters(h.ports, h.auth)).toEqual({
      kind: "reauth-required",
      guidance: "Your saved Bambu sign-in expired. Sign in again.",
    });
    expect((await h.store.accountById(account.id))?.reauthRequired).toBe(true);
  });

  it("refuses an empty selection rather than storing one", async () => {
    await enrolFully(h);
    const result = await postPrinters(h.ports, h.auth, { deviceIds: [] });

    expect(result.kind).toBe("invalid");
  });

  it("needs an account before it will take a selection", async () => {
    const result = await postPrinters(h.ports, h.auth, {
      deviceIds: [h.printers[0]?.deviceId],
    });

    expect(result.kind).toBe("no-account");
  });
});

describe("deletion", () => {
  it("deletes the account and its screen", async () => {
    const { account } = await enrolFully(h);
    await h.store.writeScreen(account.id, { body: "{}", renderedAt: NOW });

    expect(await deleteAccount(h.ports, h.auth)).toEqual({ kind: "done" });

    expect(await h.store.accountById(account.id)).toBeNull();
    expect(await h.store.readScreen(account.id)).toBeNull();
  });

  it("lets the same person enrol again after deleting", async () => {
    await enrolFully(h);
    await deleteAccount(h.ports, h.auth);

    // The owner tag is unique, so a tombstone would make this impossible and the
    // person would be locked out of their own product.
    const again = await enrolFully(h);
    expect(again.account.deviceIds.length).toBe(1);
  });

  it("reports the account's state to its settings page", async () => {
    const { account } = await enrolFully(h);
    await h.store.markReauthRequired(account.id);

    expect(await getAccount(h.ports, h.auth)).toEqual({
      kind: "account",
      deviceIds: account.deviceIds,
      reauthRequired: true,
    });
  });
});

describe("throttling", () => {
  // Without this, an account here is a way to make Bambu email an address
  // repeatedly. Identity bounds who can do it; the limiter bounds how often.
  it("throttles one identity's sign-in attempts", async () => {
    let calls = 0;
    const limiter: RateLimiter = {
      async limit() {
        calls += 1;
        return { success: calls <= 2 };
      },
    };
    const throttled = await harness({ limiter });

    expect((await postSignInCode(throttled.ports, throttled.auth, { region: "global", email: EMAIL })).kind).toBe("done");
    expect((await postSignInCode(throttled.ports, throttled.auth, { region: "global", email: EMAIL })).kind).toBe("done");
    const third = await postSignInCode(throttled.ports, throttled.auth, {
      region: "global",
      email: EMAIL,
    });

    expect(third.kind).toBe("throttled");
    // Refused before Bambu, so the limiter bounds the outbound email and not
    // merely our own status code.
    expect(throttled.sent.length).toBe(2);
  });

  it("keys the limit to the identity, not the request", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = {
      async limit({ key }) {
        keys.push(key);
        return { success: true };
      },
    };
    const counted = await harness({ limiter });
    await postSignInCode(counted.ports, counted.auth, { region: "global", email: EMAIL });
    await postSignInCode(counted.ports, counted.otherAuth, { region: "global", email: EMAIL });

    // Two identities, two counters; and the key is the owner tag, so it is
    // neither the subject nor anything a request supplied.
    expect(new Set(keys).size).toBe(2);
    expect(keys.some((key) => key.includes("subject-"))).toBe(false);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  // The opposite of the screen endpoint's choice, deliberately. There a limiter
  // fault costs only our own database work, so failing closed would be an
  // outage. Here the limiter is the only bound on how often we can make Bambu
  // email an address, so a fault must stop us rather than free us. New enrolment
  // pauses; every configured display keeps working on a different route.
  it("refuses a sign-in when the limiter cannot answer", async () => {
    const broken: RateLimiter = { limit: () => Promise.reject(new Error("down")) };
    const degraded = await harness({ limiter: broken });

    const result = await postSignInCode(degraded.ports, degraded.auth, {
      region: "global",
      email: EMAIL,
    });

    expect(result.kind).toBe("throttled");
    // Refused before Bambu, which is the point.
    expect(degraded.sent).toEqual([]);
  });

  // Not a mail path, so a smaller exposure than the sign-in routes, but still an
  // authenticated path to repeated Bambu calls. `store.ts` says plainly that a
  // loop against the cloud is what earns an account a ban.
  it("meters the printer route, which also reaches Bambu", async () => {
    let calls = 0;
    const limiter: RateLimiter = {
      async limit() {
        calls += 1;
        return { success: calls <= 2 };
      },
    };
    const metered = await harness({ limiter });
    let listings = 0;
    const counting: EnrolPorts = {
      ...metered.ports,
      async printersFor(account) {
        listings += 1;
        return await metered.ports.printersFor(account);
      },
    };

    // Two of the budget go to the sign-in pair, so the picker is already over.
    await postSignInCode(counting, metered.auth, { region: "global", email: EMAIL });
    await postSession(counting, metered.auth, { region: "global", email: EMAIL, code: CODE });
    const refused = await postPrinters(counting, metered.auth, {
      deviceIds: [metered.printers[0]?.deviceId],
    });

    expect(refused.kind).toBe("throttled");
    // Refused before the cloud call, not after it.
    expect(listings).toBe(0);
  });

  it("does not spend budget on a malformed selection", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = {
      async limit({ key }) {
        keys.push(key);
        return { success: true };
      },
    };
    const counted = await harness({ limiter });
    await postSession(counted.ports, counted.auth, { region: "global", email: EMAIL, code: CODE });
    const before = keys.length;

    expect((await postPrinters(counted.ports, counted.auth, { deviceIds: [] })).kind).toBe("invalid");

    // Cheap validation first: a bad request should not cost a legitimate one.
    expect(keys.length).toBe(before);
  });
});

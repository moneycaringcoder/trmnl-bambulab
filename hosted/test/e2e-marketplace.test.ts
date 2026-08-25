/**
 * The marketplace flow against real Postgres, end to end.
 *
 * Opt-in: set `E2E_DATABASE_URL` to a throwaway database and this suite runs
 * both migrations and drives install → webhook → enrol → markup → uninstall
 * against a real server. Without the variable it skips, so CI and ordinary
 * local runs never need a database.
 *
 * The pieces no unit test can vouch for live here: migration 0002 applying
 * onto 0001, and `NeonStore`'s installation queries against real Postgres
 * rather than the memory twin — bigint round-trips, ON DELETE behaviour, the
 * partial index still accepting the claim query.
 */

import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { importKeyringFromEnv, openToken, sealToken } from "../src/crypto.ts";
import { NeonStore } from "../src/store-neon.ts";
import {
  identifyInstallation,
  install,
  markup,
  recordInstallSuccess,
  uninstall,
  verifyManageToken,
  type TrmnlPorts,
} from "../src/trmnl.ts";

const DATABASE_URL = process.env.E2E_DATABASE_URL;

describe.skipIf(DATABASE_URL === undefined)("the marketplace flow on real Postgres", () => {
  it("runs install, webhook, enrol, markup and uninstall end to end", async () => {
    if (DATABASE_URL === undefined) throw new Error("unreachable: suite is skipped");
    const sql = neon(DATABASE_URL);

    // Both migrations, in order, the way a fresh deployment runs them.
    for (const file of ["0001_initial.sql", "0002_trmnl_installations.sql"]) {
      const ddl = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      for (const statement of ddl
        .split(/;\s*\n/)
        .map((piece) => piece.trim())
        .filter((piece) => piece.length > 0)) {
        await sql.query(statement);
      }
    }
    const columns: unknown = await sql.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='accounts'",
    );
    expect(
      (columns as { column_name: string }[]).some(
        (column) => column.column_name === "screen_key_fingerprint",
      ),
    ).toBe(false);

    // A real keyring over a generated key; nothing here is pasted.
    const raw = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    const keyring = await importKeyringFromEnv({
      TOKEN_KEY_K1: btoa(binary),
      TOKEN_KEY_CURRENT_ID: "k1",
    });
    const store = new NeonStore(DATABASE_URL);
    const ports: TrmnlPorts = {
      store,
      keyring,
      async exchangeCode(code) {
        return code === "good-code"
          ? { ok: true, accessToken: "trmnl-access-token" } // secret-scan-allow: synthetic test credential
          : { ok: false };
      },
      now: () => Date.now(),
    };

    // Install, and resolve it back through the real unique index.
    const installed = await install(ports, "good-code");
    if (installed.kind !== "installed") throw new Error("install failed");
    const installation = await identifyInstallation(ports, "Bearer trmnl-access-token");
    expect(installation).not.toBeNull();
    const verified = await verifyManageToken(keyring, store, installed.manageToken, Date.now());
    expect(verified?.id).toBe(installation?.id);

    // The success webhook, including the bigint round-trip.
    const uuid = crypto.randomUUID();
    expect(
      await recordInstallSuccess(ports, "Bearer trmnl-access-token", {
        user: { uuid, plugin_setting_id: 1234 },
      }),
    ).toBe("done");
    const recorded = await identifyInstallation(ports, "Bearer trmnl-access-token");
    expect(recorded?.userUuid).toBe(uuid);
    expect(recorded?.pluginSettingId).toBe(1234);

    // Enrol: a real sealed token, a linked account, a stored render.
    const accountId = crypto.randomUUID();
    await store.createAccount({
      id: accountId,
      ownerTag: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
      region: "global",
      token: await sealToken(keyring, accountId, `synthetic-${crypto.randomUUID()}`),
      deviceIds: [`${"0".repeat(12)}A1`],
      maxPayloadBytes: 2048,
      exportJobName: false,
    });
    const account = await store.accountById(accountId);
    expect(account).not.toBeNull();
    if (account === null) throw new Error("unreachable");
    await expect(openToken(keyring, accountId, account.token)).resolves.toContain("synthetic-");

    if (installation === null) throw new Error("unreachable");
    await store.linkInstallationAccount(installation.id, accountId);
    await store.writeScreen(accountId, {
      body: JSON.stringify({
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
            nozzle: 220,
            bed: 60,
          },
        ],
        hidden: 0,
        cloud: "connected",
      }),
      renderedAt: Date.now(),
    });

    // Markup: real store, real Liquid templates, all four layouts.
    const rendered = await markup(ports, "Bearer trmnl-access-token");
    if (rendered.kind !== "markup") throw new Error("markup refused");
    for (const key of [
      "markup",
      "markup_half_horizontal",
      "markup_half_vertical",
      "markup_quadrant",
    ] as const) {
      expect(rendered.markup[key].length).toBeGreaterThan(0);
    }
    expect(rendered.markup.markup).toContain("42%");

    // The cron's claim query still works on the migrated schema.
    const due = await store.dueAccounts(5, Date.now() + 60_000);
    expect(due.some((entry) => entry.id === accountId)).toBe(true);

    // Uninstall deletes everything, verified with raw counts.
    expect(await uninstall(ports, "Bearer trmnl-access-token")).toBe("done");
    const counts: unknown = await sql.query(
      "SELECT (SELECT count(*)::int FROM accounts) AS a, (SELECT count(*)::int FROM screens) AS s, (SELECT count(*)::int FROM trmnl_installations) AS i",
    );
    expect((counts as { a: number; s: number; i: number }[])[0]).toEqual({ a: 0, s: 0, i: 0 });
  }, 120_000);
});

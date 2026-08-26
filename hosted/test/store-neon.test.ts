import type { NeonQueryFunction } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";

import { NeonStore } from "@trmnl-bambulab/core/hosted/store-neon";

function queryReturning(
  rows: unknown[],
  statements: string[] = [],
): NeonQueryFunction<false, false> {
  return (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    statements.push(strings.join("?"));
    return rows;
  }) as unknown as NeonQueryFunction<false, false>;
}

function installationRow(pluginSettingId: unknown) {
  return {
    id: ["installation", crypto.randomUUID()].join("-"),
    access_token_tag: "a".repeat(64),
    user_uuid: ["user", crypto.randomUUID()].join("-"),
    plugin_setting_id: pluginSettingId,
    account_id: null,
  };
}

function accountRow(label: string) {
  return {
    id: ["account", label, crypto.randomUUID()].join("-"),
    owner_tag: "b".repeat(64),
    region: "global",
    token_key_id: ["key", label].join("-"),
    token_nonce: btoa(["nonce", label, crypto.randomUUID()].join("-")),
    token_ciphertext: btoa(["ciphertext", label, crypto.randomUUID()].join("-")),
    device_ids: [["device", label, crypto.randomUUID()].join("-")],
    max_payload_bytes: 2_000,
    export_job_name: false,
    reauth_required: false,
  };
}

describe("NeonStore row boundaries", () => {
  it("rejects bigint strings which cannot be represented without rounding", async () => {
    const unsafe = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    const unsafeStore = new NeonStore(
      "postgres://unused",
      queryReturning([installationRow(unsafe)]),
    );

    await expect(unsafeStore.installationById("ignored")).resolves.toBeNull();

    const safe = Number.MAX_SAFE_INTEGER.toString();
    const safeStore = new NeonStore(
      "postgres://unused",
      queryReturning([installationRow(safe)]),
    );
    await expect(safeStore.installationById("ignored")).resolves.toMatchObject({
      pluginSettingId: Number.MAX_SAFE_INTEGER,
    });
  });

  it("discovers collectable accounts with one ordered read-only query", async () => {
    const statements: string[] = [];
    const first = accountRow("first");
    const second = accountRow("second");
    const store = new NeonStore(
      "postgres://unused",
      queryReturning([first, second], statements),
    );

    await expect(store.collectableAccounts(2)).resolves.toMatchObject([
      { id: first.id },
      { id: second.id },
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("cardinality(device_ids) > 0");
    expect(statements[0]).toContain("ORDER BY created_at ASC, id ASC");
    expect(statements[0]).not.toMatch(/\bUPDATE\b/);
  });
});

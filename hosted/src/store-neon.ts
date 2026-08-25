/**
 * The hosted store backed by Neon Postgres.
 *
 * A five-minute cron invocation and TRMNL screen refreshes issue one-shot
 * queries, so the `neon()` HTTP tagged template is the right transport: it has
 * no connection lifecycle, no pool to keep warm, and no TCP or WebSocket
 * requirement in a Cloudflare Worker. A WebSocket `Pool` would add state this
 * workload cannot reuse and would make overlapping invocations harder to reason
 * about.
 *
 * This module never opens token ciphertext and has no logging surface. Database
 * rows are untrusted at the TypeScript boundary: each field is checked without
 * coercion. Serviceable-account queries skip malformed rows, while a malformed
 * stored screen is rejected rather than served to TRMNL.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import type { SealedToken } from "./crypto.ts";
import type { Account, Installation, Screen, Store } from "./store.ts";

interface RowDrift {
  ok: false;
  reason: string;
}

interface Parsed<T> {
  ok: true;
  value: T;
}

type ParseResult<T> = Parsed<T> | RowDrift;

type DatabaseRow = Record<string, unknown>;

function isDatabaseRow(value: unknown): value is DatabaseRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A drift reason names the column and nothing else.
 *
 * Deliberately not the account id. These reasons are thrown, and a thrown
 * message is one careless `logger.error(msg, { reason: error.message })` away
 * from a log line. `accountTag` in `log.ts` exists precisely so a raw account
 * id never reaches a log, and its unsalted hash only stays non-reversible while
 * the id stays out of everything else. The column is the whole diagnostic
 * value anyway: it says which part of the schema drifted.
 */
function drift(column: string, expected: string): RowDrift {
  return { ok: false, reason: `column "${column}" drifted: expected ${expected}` };
}

function parseAccount(value: unknown): ParseResult<Account> {
  if (!isDatabaseRow(value)) return drift("row", "an object");

  const id = value.id;
  if (typeof id !== "string" || id.length === 0) {
    return drift("id", "a non-empty string");
  }
  const ownerTag = value.owner_tag;
  if (typeof ownerTag !== "string" || ownerTag.length === 0) {
    return drift("owner_tag", "a non-empty string");
  }
  const region = value.region;
  if (region !== "global" && region !== "china") {
    return drift("region", '"global" or "china"');
  }
  const keyId = value.token_key_id;
  if (typeof keyId !== "string" || keyId.length === 0) {
    return drift("token_key_id", "a non-empty string");
  }
  const nonce = value.token_nonce;
  if (typeof nonce !== "string" || nonce.length === 0) {
    return drift("token_nonce", "a non-empty string");
  }
  const ciphertext = value.token_ciphertext;
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    return drift("token_ciphertext", "a non-empty string");
  }
  const deviceIds = value.device_ids;
  if (
    !Array.isArray(deviceIds) ||
    !deviceIds.every((deviceId) => typeof deviceId === "string" && deviceId.length > 0)
  ) {
    return drift("device_ids", "an array of non-empty strings");
  }
  const maxPayloadBytes = value.max_payload_bytes;
  if (!Number.isSafeInteger(maxPayloadBytes) || (maxPayloadBytes as number) <= 0) {
    return drift("max_payload_bytes", "a positive safe integer");
  }
  const exportJobName = value.export_job_name;
  if (typeof exportJobName !== "boolean") {
    return drift("export_job_name", "a boolean");
  }
  const reauthRequired = value.reauth_required;
  if (typeof reauthRequired !== "boolean") {
    return drift("reauth_required", "a boolean");
  }

  return {
    ok: true,
    value: {
      id,
      ownerTag,
      region,
      token: { keyId, nonce, ciphertext },
      deviceIds,
      maxPayloadBytes: maxPayloadBytes as number,
      exportJobName,
      reauthRequired,
    },
  };
}

function parseInstallation(value: unknown): ParseResult<Installation> {
  if (!isDatabaseRow(value)) return drift("installations row", "an object");

  const id = value.id;
  if (typeof id !== "string" || id.length === 0) {
    return drift("id", "a non-empty string");
  }
  const accessTokenTag = value.access_token_tag;
  if (typeof accessTokenTag !== "string" || accessTokenTag.length === 0) {
    return drift("access_token_tag", "a non-empty string");
  }
  const userUuid = value.user_uuid;
  if (userUuid !== null && (typeof userUuid !== "string" || userUuid.length === 0)) {
    return drift("user_uuid", "null or a non-empty string");
  }
  // Postgres bigint arrives as a string through the HTTP driver; both shapes
  // are accepted rather than trusting driver configuration.
  const rawSettingId = value.plugin_setting_id;
  let pluginSettingId: number | null;
  if (rawSettingId === null) pluginSettingId = null;
  else if (Number.isSafeInteger(rawSettingId)) pluginSettingId = rawSettingId as number;
  else if (typeof rawSettingId === "string" && /^\d+$/.test(rawSettingId)) {
    pluginSettingId = Number(rawSettingId);
  } else return drift("plugin_setting_id", "null or an integer");
  const accountId = value.account_id;
  if (accountId !== null && (typeof accountId !== "string" || accountId.length === 0)) {
    return drift("account_id", "null or a non-empty string");
  }

  return {
    ok: true,
    value: { id, accessTokenTag, userUuid, pluginSettingId, accountId },
  };
}

function parseScreen(value: unknown): ParseResult<Screen> {
  if (!isDatabaseRow(value)) return drift("screens row", "an object");

  const body = value.body;
  if (typeof body !== "string") {
    return drift("body", "a string");
  }
  const renderedAt = value.rendered_at;
  if (!Number.isSafeInteger(renderedAt) || (renderedAt as number) < 0) {
    return drift("rendered_at", "a non-negative safe integer");
  }

  return { ok: true, value: { body, renderedAt: renderedAt as number } };
}

function rowsFrom(result: unknown): unknown[] {
  if (!Array.isArray(result)) throw new Error("database query returned a non-array result");
  return result;
}

export class NeonStore implements Store {
  private readonly sql: NeonQueryFunction<false, false>;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  async dueAccounts(limit: number, renderedBefore: number): Promise<Account[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("due account limit must be a non-negative safe integer");
    }
    if (limit === 0) return [];

    // `FOR UPDATE SKIP LOCKED` claims disjoint rows when cron invocations overlap.
    // The update is in the same statement as the claim, so locks cannot escape
    // before `last_serviced_at` advances and a crashing account moves behind its
    // peers before any external request begins.
    const result: unknown = await this.sql`
      WITH due AS (
        SELECT
          id,
          last_serviced_at AS previous_last_serviced_at,
          created_at AS previous_created_at
        FROM accounts
        WHERE reauth_required = false
        ORDER BY last_serviced_at ASC NULLS FIRST, created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      ), fresh AS (
        -- Accounts something has already rendered more recently than the cutoff.
        -- Claimed above and then dropped here, so their turn is spent rather
        -- than deferred: a collector writing every few seconds must not park an
        -- account permanently at the head of the queue.
        SELECT due.id
        FROM due
        JOIN screens ON screens.account_id = due.id
        WHERE screens.rendered_at >= ${renderedBefore}
      ), claimed AS (
        UPDATE accounts AS account
        SET last_serviced_at = clock_timestamp()
        FROM due
        WHERE account.id = due.id
        RETURNING
          account.id,
          account.owner_tag,
          account.region,
          account.token_key_id,
          account.token_nonce,
          account.token_ciphertext,
          account.device_ids,
          account.max_payload_bytes,
          account.export_job_name,
          account.reauth_required,
          due.previous_last_serviced_at,
          due.previous_created_at
      )
      SELECT
        id,
        owner_tag,
        region,
        token_key_id,
        token_nonce,
        token_ciphertext,
        device_ids,
        max_payload_bytes,
        export_job_name,
        reauth_required
      FROM claimed
      WHERE id NOT IN (SELECT id FROM fresh)
      ORDER BY previous_last_serviced_at ASC NULLS FIRST, previous_created_at ASC, id ASC
    `;

    // A row whose shape has drifted is skipped rather than coerced: a coerced
    // account could be pointed at the wrong host or expose another account's
    // stored screen. It is skipped silently because the only informative thing
    // to log about it is the row itself, and the row holds identifiers.
    const accounts: Account[] = [];
    for (const row of rowsFrom(result)) {
      const parsed = parseAccount(row);
      if (parsed.ok) accounts.push(parsed.value);
    }
    return accounts;
  }

  async accountById(id: string): Promise<Account | null> {
    const result: unknown = await this.sql`
      SELECT
        id,
        owner_tag,
        region,
        token_key_id,
        token_nonce,
        token_ciphertext,
        device_ids,
        max_payload_bytes,
        export_job_name,
        reauth_required
      FROM accounts
      WHERE id = ${id}
    `;
    const row = rowsFrom(result)[0];
    if (row === undefined) return null;
    const parsed = parseAccount(row);
    return parsed.ok ? parsed.value : null;
  }

  async accountByOwner(candidateTags: readonly string[]): Promise<Account | null> {
    const result: unknown = await this.sql`
      SELECT
        id,
        owner_tag,
        region,
        token_key_id,
        token_nonce,
        token_ciphertext,
        device_ids,
        max_payload_bytes,
        export_job_name,
        reauth_required
      FROM accounts
      WHERE owner_tag = ANY(${[...candidateTags]})
      LIMIT 1
    `;
    const row = rowsFrom(result)[0];
    if (row === undefined) return null;
    const parsed = parseAccount(row);
    return parsed.ok ? parsed.value : null;
  }

  async installationByTokenTag(candidateTags: readonly string[]): Promise<Installation | null> {
    // The markup hot path: one equality query against the UNIQUE constraint's
    // index. Every candidate tag, because a tag cannot be recomputed after a key
    // rotation without the token, which is deliberately not kept.
    const result: unknown = await this.sql`
      SELECT id, access_token_tag, user_uuid, plugin_setting_id, account_id
      FROM trmnl_installations
      WHERE access_token_tag = ANY(${[...candidateTags]})
      LIMIT 1
    `;
    const row = rowsFrom(result)[0];
    if (row === undefined) return null;
    const parsed = parseInstallation(row);
    return parsed.ok ? parsed.value : null;
  }

  async installationById(id: string): Promise<Installation | null> {
    const result: unknown = await this.sql`
      SELECT id, access_token_tag, user_uuid, plugin_setting_id, account_id
      FROM trmnl_installations
      WHERE id = ${id}
    `;
    const row = rowsFrom(result)[0];
    if (row === undefined) return null;
    const parsed = parseInstallation(row);
    return parsed.ok ? parsed.value : null;
  }

  async createInstallation(installation: Installation): Promise<void> {
    await this.sql`
      INSERT INTO trmnl_installations (
        id, access_token_tag, user_uuid, plugin_setting_id, account_id
      ) VALUES (
        ${installation.id},
        ${installation.accessTokenTag},
        ${installation.userUuid},
        ${installation.pluginSettingId},
        ${installation.accountId}
      )
    `;
  }

  async recordInstallationUser(
    id: string,
    userUuid: string,
    pluginSettingId: number | null,
  ): Promise<void> {
    await this.sql`
      UPDATE trmnl_installations
      SET user_uuid = ${userUuid}, plugin_setting_id = ${pluginSettingId}
      WHERE id = ${id}
    `;
  }

  async linkInstallationAccount(id: string, accountId: string): Promise<void> {
    await this.sql`
      UPDATE trmnl_installations
      SET account_id = ${accountId}
      WHERE id = ${id}
    `;
  }

  async deleteInstallation(id: string): Promise<void> {
    await this.sql`
      DELETE FROM trmnl_installations
      WHERE id = ${id}
    `;
  }

  async createAccount(account: Omit<Account, "reauthRequired">): Promise<Account> {
    // No screens row is created here. Its absence is the legitimate state before
    // the first cron render, and `readScreen` represents that state as null. The
    // first `writeScreen` inserts the row atomically when there is real content.
    await this.sql`
      INSERT INTO accounts (
        id,
        owner_tag,
        region,
        token_key_id,
        token_nonce,
        token_ciphertext,
        device_ids,
        max_payload_bytes,
        export_job_name,
        reauth_required
      ) VALUES (
        ${account.id},
        ${account.ownerTag},
        ${account.region},
        ${account.token.keyId},
        ${account.token.nonce},
        ${account.token.ciphertext},
        ${account.deviceIds},
        ${account.maxPayloadBytes},
        ${account.exportJobName},
        false
      )
    `;
    return {
      id: account.id,
      ownerTag: account.ownerTag,
      region: account.region,
      token: {
        keyId: account.token.keyId,
        nonce: account.token.nonce,
        ciphertext: account.token.ciphertext,
      },
      deviceIds: [...account.deviceIds],
      maxPayloadBytes: account.maxPayloadBytes,
      exportJobName: account.exportJobName,
      reauthRequired: false,
    };
  }

  async replaceToken(accountId: string, token: SealedToken): Promise<void> {
    await this.sql`
      UPDATE accounts
      SET
        token_key_id = ${token.keyId},
        token_nonce = ${token.nonce},
        token_ciphertext = ${token.ciphertext},
        reauth_required = false
      WHERE id = ${accountId}
    `;
  }

  async replacePrinters(accountId: string, deviceIds: readonly string[]): Promise<void> {
    await this.sql`
      UPDATE accounts
      SET device_ids = ${[...deviceIds]}
      WHERE id = ${accountId}
    `;
  }

  async markReauthRequired(accountId: string): Promise<void> {
    await this.sql`
      UPDATE accounts
      SET reauth_required = true
      WHERE id = ${accountId}
    `;
  }

  async readScreen(accountId: string): Promise<Screen | null> {
    const result: unknown = await this.sql`
      SELECT
        body,
        rendered_at::double precision AS rendered_at
      FROM screens
      WHERE account_id = ${accountId}
    `;
    const row = rowsFrom(result)[0];
    if (row === undefined) return null;

    const parsed = parseScreen(row);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.value;
  }

  async writeScreen(accountId: string, screen: Screen): Promise<void> {
    const parsed = parseScreen({ body: screen.body, rendered_at: screen.renderedAt });
    if (!parsed.ok) throw new Error(parsed.reason);

    await this.sql`
      INSERT INTO screens (
        account_id,
        body,
        rendered_at
      ) VALUES (
        ${accountId},
        ${parsed.value.body},
        ${parsed.value.renderedAt}
      )
      ON CONFLICT (account_id) DO UPDATE SET
        body = EXCLUDED.body,
        rendered_at = EXCLUDED.rendered_at
    `;
  }

  async deleteAccount(accountId: string): Promise<void> {
    // The foreign key's ON DELETE CASCADE removes the rendered screen in this
    // same statement, so there is no partial-deletion window or retained payload.
    await this.sql`
      DELETE FROM accounts
      WHERE id = ${accountId}
    `;
  }
}

/**
 * The hosted store backed by Neon Postgres.
 *
 * A five-minute cron invocation issues only a handful of one-shot queries, so
 * the `neon()` HTTP tagged template is the right transport: it has no connection
 * lifecycle, no pool to keep warm, and no TCP or WebSocket requirement in a
 * Cloudflare Worker. A WebSocket `Pool` would add state this workload cannot
 * reuse and would make overlapping invocations harder to reason about.
 *
 * This module never opens token ciphertext and has no logging surface. Database
 * rows are untrusted at the TypeScript boundary: each field is checked without
 * coercion. Serviceable-account queries skip malformed rows, while malformed
 * scheduler state fails closed rather than resetting a rate limit.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import type { SealedToken } from "./crypto.ts";
import type { Account, PushRecord, Store } from "./store.ts";

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
  const webhookUrl = value.webhook_url;
  if (typeof webhookUrl !== "string" || webhookUrl.length === 0) {
    return drift("webhook_url", "a non-empty string");
  }
  const maxPushesPerHour = value.max_pushes_per_hour;
  if (!Number.isSafeInteger(maxPushesPerHour) || (maxPushesPerHour as number) <= 0) {
    return drift("max_pushes_per_hour", "a positive safe integer");
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
      region,
      token: { keyId, nonce, ciphertext },
      deviceIds,
      webhookUrl,
      maxPushesPerHour: maxPushesPerHour as number,
      maxPayloadBytes: maxPayloadBytes as number,
      exportJobName,
      reauthRequired,
    },
  };
}

function parsePushRecord(value: unknown): ParseResult<PushRecord> {
  if (!isDatabaseRow(value)) return drift("push_records row", "an object");

  const recentPushes = value.recent_pushes;
  if (
    !Array.isArray(recentPushes) ||
    !recentPushes.every(
      (pushedAt) => Number.isSafeInteger(pushedAt) && (pushedAt as number) >= 0,
    )
  ) {
    return drift("recent_pushes", "an array of non-negative safe integers");
  }
  const lastSerialized = value.last_serialized;
  if (lastSerialized !== null && typeof lastSerialized !== "string") {
    return drift("last_serialized", "a string or null");
  }
  const lastPushedAt = value.last_pushed_at;
  if (
    lastPushedAt !== null &&
    (!Number.isSafeInteger(lastPushedAt) || (lastPushedAt as number) < 0)
  ) {
    return drift("last_pushed_at", "a non-negative safe integer or null");
  }

  return {
    ok: true,
    value: {
      recentPushes,
      lastSerialized,
      lastPushedAt: lastPushedAt as number | null,
    },
  };
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

  async dueAccounts(limit: number): Promise<Account[]> {
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
      ), claimed AS (
        UPDATE accounts AS account
        SET last_serviced_at = clock_timestamp()
        FROM due
        WHERE account.id = due.id
        RETURNING
          account.id,
          account.region,
          account.token_key_id,
          account.token_nonce,
          account.token_ciphertext,
          account.device_ids,
          account.webhook_url,
          account.max_pushes_per_hour,
          account.max_payload_bytes,
          account.export_job_name,
          account.reauth_required,
          due.previous_last_serviced_at,
          due.previous_created_at
      )
      SELECT
        id,
        region,
        token_key_id,
        token_nonce,
        token_ciphertext,
        device_ids,
        webhook_url,
        max_pushes_per_hour,
        max_payload_bytes,
        export_job_name,
        reauth_required
      FROM claimed
      ORDER BY previous_last_serviced_at ASC NULLS FIRST, previous_created_at ASC, id ASC
    `;

    // A row whose shape has drifted is skipped rather than coerced: a coerced
    // account could be pointed at the wrong host or handed someone else's
    // webhook. It is skipped silently because the only informative thing to log
    // about it is the row itself, and the row holds a credential and an
    // identifier. Operationally it surfaces as fewer cycles than accounts.
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
        region,
        token_key_id,
        token_nonce,
        token_ciphertext,
        device_ids,
        webhook_url,
        max_pushes_per_hour,
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

  async createAccount(account: Omit<Account, "reauthRequired">): Promise<Account> {
    await this.sql`
      WITH created AS (
        INSERT INTO accounts (
          id,
          region,
          token_key_id,
          token_nonce,
          token_ciphertext,
          device_ids,
          webhook_url,
          max_pushes_per_hour,
          max_payload_bytes,
          export_job_name,
          reauth_required
        ) VALUES (
          ${account.id},
          ${account.region},
          ${account.token.keyId},
          ${account.token.nonce},
          ${account.token.ciphertext},
          ${account.deviceIds},
          ${account.webhookUrl},
          ${account.maxPushesPerHour},
          ${account.maxPayloadBytes},
          ${account.exportJobName},
          false
        )
        RETURNING id
      )
      INSERT INTO push_records (account_id)
      SELECT id FROM created
    `;
    return {
      id: account.id,
      region: account.region,
      token: {
        keyId: account.token.keyId,
        nonce: account.token.nonce,
        ciphertext: account.token.ciphertext,
      },
      deviceIds: [...account.deviceIds],
      webhookUrl: account.webhookUrl,
      maxPushesPerHour: account.maxPushesPerHour,
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

  async markReauthRequired(accountId: string): Promise<void> {
    await this.sql`
      UPDATE accounts
      SET reauth_required = true
      WHERE id = ${accountId}
    `;
  }

  async readPushRecord(accountId: string): Promise<PushRecord> {
    const result: unknown = await this.sql`
      SELECT
        recent_pushes::double precision[] AS recent_pushes,
        last_serialized,
        last_pushed_at::double precision AS last_pushed_at
      FROM push_records
      WHERE account_id = ${accountId}
    `;
    const row = rowsFrom(result)[0];
    if (row === undefined) {
      return { recentPushes: [], lastSerialized: null, lastPushedAt: null };
    }

    const parsed = parsePushRecord(row);
    // Returning an empty record on drift would erase the durable rate-limit
    // budget. Fail closed with a column-specific reason instead.
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.value;
  }

  async writePushRecord(accountId: string, record: PushRecord): Promise<void> {
    const parsed = parsePushRecord({
      recent_pushes: record.recentPushes,
      last_serialized: record.lastSerialized,
      last_pushed_at: record.lastPushedAt,
    });
    if (!parsed.ok) throw new Error(parsed.reason);

    await this.sql`
      INSERT INTO push_records (
        account_id,
        recent_pushes,
        last_serialized,
        last_pushed_at
      ) VALUES (
        ${accountId},
        ${parsed.value.recentPushes},
        ${parsed.value.lastSerialized},
        ${parsed.value.lastPushedAt}
      )
      ON CONFLICT (account_id) DO UPDATE SET
        recent_pushes = EXCLUDED.recent_pushes,
        last_serialized = EXCLUDED.last_serialized,
        last_pushed_at = EXCLUDED.last_pushed_at
    `;
  }

  async deleteAccount(accountId: string): Promise<void> {
    // The foreign key's ON DELETE CASCADE removes the push record in this same
    // statement, so there is no partial-deletion window and no retained tombstone.
    await this.sql`
      DELETE FROM accounts
      WHERE id = ${accountId}
    `;
  }
}

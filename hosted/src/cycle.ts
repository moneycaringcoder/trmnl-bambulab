/**
 * One hosted polling and push cycle, independent of the Workers runtime.
 *
 * The clock, durable store and two network operations arrive as dependencies so
 * tests can exercise the real orchestration with an in-memory store and
 * controlled HTTP. This module reads Bambu Cloud and writes only to TRMNL; it
 * has no transport capable of sending anything to a printer.
 */

import { accept, emptyCoordinatorState, snapshotsFor } from "../../bridge/src/coordinator/merge.ts";
import { buildWebhookPayload } from "../../bridge/src/push/payload.ts";
import { decide, recordPush } from "../../bridge/src/push/scheduler.ts";
import {
  pollCloudHttp,
  type PollOptions,
  type PollResult,
} from "../../bridge/src/providers/cloud-http.ts";
import { hostsFor } from "../../bridge/src/providers/bambu-cloud/hosts.ts";
import {
  pushPayload,
  type PushResult,
} from "../../bridge/src/setup/webhook-push.ts";
import type { ProviderStatus } from "../../bridge/src/types.ts";
import { openToken, type Keyring } from "./crypto.ts";
import { accountTag } from "./log.ts";
import type { Account, Store } from "./store.ts";

export interface CycleDependencies {
  store: Store;
  keyring: Keyring;
  pollCloud: (options: PollOptions) => Promise<PollResult>;
  pushWebhook: (url: string, body: unknown) => Promise<PushResult>;
}

export interface CycleOptions {
  account: Account;
  /** Epoch milliseconds, captured once for a consistent poll and decision. */
  now: number;
}

export type CycleResult =
  | { kind: "reauth_required" }
  | {
      kind: "pushed";
      reason: "changed" | "heartbeat";
      cloud: ProviderStatus;
      bytes: number;
    }
  | {
      kind: "push_refused";
      reason: Exclude<PushResult, { ok: true }>["kind"];
      cloud: ProviderStatus;
      status: number;
    }
  | {
      kind: "skipped";
      reason: "unchanged" | "rate-limited" | "too-large" | "not-sendable";
      cloud: ProviderStatus;
      bytes: number;
    };

/**
 * Services one account from encrypted token through an optional webhook push.
 *
 * The coordinator deliberately starts empty on every invocation. A cron isolate
 * has no memory of the previous run, so the hosted tier sees only what this one
 * HTTP poll returned. That is the D3 capability split: unlike the self-hosted
 * MQTT-enriched bridge, the hosted display has no layer counts or temperatures.
 */
export async function runCycle(
  deps: CycleDependencies,
  options: CycleOptions,
): Promise<CycleResult> {
  const { account, now } = options;
  const accessToken = await openToken(deps.keyring, account.id, account.token);
  const poll = await deps.pollCloud({
    hosts: hostsFor(account.region),
    accessToken,
    deviceIds: account.deviceIds,
    exportJobName: account.exportJobName,
    now,
  });

  if (poll.status === "reauth_required") {
    // Retrying a credential the cloud has refused cannot succeed. Stopping here
    // avoids the rejecting loop that can get the user's account banned.
    await deps.store.markReauthRequired(account.id);
    return { kind: "reauth_required" };
  }

  let coordinator = emptyCoordinatorState();
  for (const observation of poll.observations) {
    coordinator = accept(coordinator, observation);
  }
  const snapshots = snapshotsFor(coordinator, account.deviceIds, now);
  const payload = buildWebhookPayload(snapshots, {
    now,
    cloud: poll.status,
    maxBytes: account.maxPayloadBytes,
    exportJobName: account.exportJobName,
  });
  const pushRecord = await deps.store.readPushRecord(account.id);
  const decision = decide(pushRecord, payload, {
    now,
    maxPushesPerHour: account.maxPushesPerHour,
    maxPayloadBytes: account.maxPayloadBytes,
  });

  if (decision.kind === "skip") {
    return {
      kind: "skipped",
      reason: decision.reason,
      cloud: poll.status,
      bytes: payload.bytes,
    };
  }

  const pushed = await deps.pushWebhook(account.webhookUrl, payload.body);
  if (!pushed.ok) {
    // A refused push spent no TRMNL budget. Recording it would both invent a
    // spend and suppress the retry that a transient refusal deserves.
    return {
      kind: "push_refused",
      reason: pushed.kind,
      cloud: poll.status,
      status: pushed.status,
    };
  }

  const next = recordPush(pushRecord, now, payload.serialized);
  await deps.store.writePushRecord(account.id, {
    recentPushes: [...next.recentPushes],
    lastSerialized: next.lastSerialized,
    lastPushedAt: next.lastPushedAt,
  });
  return {
    kind: "pushed",
    reason: decision.reason,
    cloud: poll.status,
    bytes: payload.bytes,
  };
}

/**
 * The Workers Free plan permits 50 external subrequests per invocation. Each
 * account has a worst case of two Bambu reads and one TRMNL push, so fifteen
 * accounts spend at most 45 and leave five requests of headroom.
 */
export const MAX_ACCOUNTS_PER_CYCLE = 15;

export interface DueAccountsOptions {
  now: number;
  limit?: number;
}

export interface AccountCycleSummary {
  accountTag: string;
  result: CycleResult | { kind: "failed" };
}

/**
 * Services a bounded batch while containing every account-local failure.
 *
 * One account at a time, deliberately. Workers allow six simultaneous outbound
 * connections per invocation, so a batch of fifteen fanned out at once would
 * attempt thirty and most would queue regardless. Serial also means the cycle
 * asks Bambu for one account's data at a time rather than arriving as a burst,
 * which matters for a service that has previously objected to being hammered.
 * Waiting on a fetch costs wall time rather than CPU time, and CPU time is what
 * a cron invocation is actually limited on.
 */
export async function runDueAccounts(
  deps: CycleDependencies,
  options: DueAccountsOptions,
): Promise<AccountCycleSummary[]> {
  const limit = Math.min(options.limit ?? MAX_ACCOUNTS_PER_CYCLE, MAX_ACCOUNTS_PER_CYCLE);
  const accounts = await deps.store.dueAccounts(limit);
  const summaries: AccountCycleSummary[] = [];

  for (const [index, account] of accounts.entries()) {
    let tag = `batch-${index + 1}`;
    try {
      tag = await accountTag(account.id);
      summaries.push({
        accountTag: tag,
        result: await runCycle(deps, { account, now: options.now }),
      });
    } catch {
      // Error objects from network and database libraries can carry a URL or
      // request detail. The account boundary reports only a fixed category, and
      // one bad account must not stop the rest of the batch.
      summaries.push({ accountTag: tag, result: { kind: "failed" } });
    }
  }

  return summaries;
}

/** Production dependencies kept explicit so tests never need a Workers `env`. */
export const networkDependencies = {
  pollCloud: pollCloudHttp,
  pushWebhook: pushPayload,
};

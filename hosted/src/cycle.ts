/**
 * One hosted polling and rendering cycle, independent of the Workers runtime.
 *
 * The clock, durable store and network operation arrive as dependencies so
 * tests can exercise the real orchestration with an in-memory store and
 * controlled HTTP. This module reads Bambu Cloud and stores a display render;
 * it has no transport capable of sending anything to a printer or to TRMNL.
 */

import {
  accept,
  emptyCoordinatorState,
  snapshotsFor,
} from "@trmnl-bambulab/core/telemetry/coordinator/merge";
import { buildWebhookPayload } from "@trmnl-bambulab/core/telemetry/push/payload";
import {
  pollCloudHttp,
  type PollOptions,
  type PollResult,
} from "@trmnl-bambulab/core/telemetry/providers/cloud-http";
import { hostsFor } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/hosts";
import type { ProviderStatus } from "@trmnl-bambulab/core/telemetry/types";
import { openToken, type Keyring } from "@trmnl-bambulab/core/hosted/crypto";
import { accountTag } from "@trmnl-bambulab/core/hosted/log";
import type { Account, Store } from "@trmnl-bambulab/core/hosted/store";
import { serializeScreen } from "@trmnl-bambulab/core/hosted/screen";

export interface CycleDependencies {
  store: Store;
  keyring: Keyring;
  pollCloud: (options: PollOptions) => Promise<PollResult>;
}

export interface CycleOptions {
  account: Account;
  /** Epoch milliseconds, captured once for a consistent poll and render. */
  now: number;
}

export type CycleResult =
  | {
      kind: "rendered";
      cloud: ProviderStatus;
      bytes: number;
    }
  | { kind: "reauth_required" }
  | {
      kind: "payload_not_sendable";
      cloud: ProviderStatus;
      bytes: number;
    };

/**
 * Services one account from encrypted token through a stored screen render.
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
    // Retrying a credential the cloud has refused cannot succeed. Keep the last
    // good screen rather than replacing it with nothing; the endpoint reports
    // its age, so its owner can see that the retained render is stale.
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
  // The builder sheds against the larger webhook envelope, so its choices are
  // conservative for this smaller flat form. Polling then puts merge variables
  // at the root; there must be no `merge_variables` envelope for TRMNL to unwrap.
  const serialized = serializeScreen(payload.variables, now, account.maxPayloadBytes);
  if (serialized.kind === "too-large") {
    return {
      kind: "payload_not_sendable",
      cloud: poll.status,
      bytes: serialized.bytes,
    };
  }

  await deps.store.writeScreen(account.id, serialized.screen);
  return {
    kind: "rendered",
    cloud: poll.status,
    bytes: serialized.bytes,
  };
}

/**
 * The batch claim costs one external request, then each account uses at most
 * two Bambu reads and one screen write. Fifteen accounts therefore stay below
 * the Workers Free plan's 50-external-subrequest ceiling.
 */
export const MAX_ACCOUNTS_PER_CYCLE = 15;

/**
 * How fresh a stored render has to be for this cron to leave it alone.
 *
 * Four minutes against a five-minute cron. The gap matters in both directions:
 * long enough that a collector writing every few seconds keeps the cron out of
 * the way entirely, and short enough that the cron never skips an account
 * because of its *own* last write, which is five minutes old by the time it
 * comes round again.
 *
 * With no collector running this changes nothing, because a screen the cron
 * rendered is always older than this by the time the next tick arrives. See
 * `docs/COLLECTOR.md`.
 */
export const DEFER_TO_RENDER_WITHIN_MS = 4 * 60_000;

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
  const accounts = await deps.store.dueAccounts(limit, options.now - DEFER_TO_RENDER_WITHIN_MS);
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
};

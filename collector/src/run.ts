/**
 * The collector loop: one MQTT session per account, for as long as it holds the
 * lease.
 *
 * Reconnection lives here rather than in the session, because Bambu has banned
 * accounts over reconnect storms and backoff needs the whole picture. A refusal
 * that retrying cannot fix — a token the cloud rejected, a subscription it
 * refused — stops that account rather than spinning against it, and the account
 * is flagged so the cron stops trying too.
 */

import { preference } from "../../bridge/src/providers/bambu-cloud/api.ts";
import { hostsFor } from "../../bridge/src/providers/bambu-cloud/hosts.ts";
import { mqttUsernameForUid } from "../../bridge/src/providers/bambu-cloud/token.ts";
import { CloudError } from "../../bridge/src/providers/bambu-cloud/http.ts";
import type { ByteStream } from "../../bridge/src/mqtt/client.ts";
import type { Observation } from "../../bridge/src/types.ts";
import type { PollOptions, PollResult } from "../../bridge/src/providers/cloud-http.ts";
import { openToken, type Keyring } from "../../hosted/src/crypto.ts";
import { accountTag, type LogDetail } from "../../hosted/src/log.ts";
import type { Account, Store } from "../../hosted/src/store.ts";
import { runAccountSession } from "./session.ts";

/** Bounded, jittered, and capped well under an hour. */
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface CollectorPorts {
  store: Store;
  keyring: Keyring;
  connect(target: { host: string; port: number }): Promise<ByteStream>;
  /**
   * The HTTP read that supplies the names MQTT does not carry.
   *
   * Injected rather than imported so a test can drive the whole account loop
   * without a network, and so the collector and the cron are visibly doing the
   * same read.
   */
  pollCloud(options: PollOptions): Promise<PollResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** True once the process should wind down. */
  stopping(): boolean;
  /**
   * Resolves when collection must end, so a live session can be closed.
   *
   * A predicate alone is not enough: a healthy MQTT session never returns, so
   * nothing would ever look at it.
   */
  stopped: Promise<void>;
  /**
   * Scalars only, deliberately.
   *
   * `hosted/src/log.ts` restricts its detail to scalars because handing a logger
   * an arbitrary object is how an account row or a response body reaches a log.
   * The collector runs where logs are easier to reach than Cloudflare's, so it
   * keeps the same boundary rather than relying on review.
   */
  log(level: "info" | "warn" | "error", message: string, detail?: LogDetail): void;
  /** Injected so a test can make the id predictable. */
  clientId(): string;
  random(): number;
}

export const ACCOUNT_START_STAGGER_MS = 250;

export interface CollectorOptions {
  /** A ceiling, so one instance cannot take on more than it was sized for. */
  maxAccounts: number;
  /** Discovery continues on this cadence while healthy account sessions stay live. */
  rediscoverMs: number;
  /**
   * Spaces cold-start admission independently of `maxAccounts`.
   *
   * Steady-state sessions remain concurrent; only the first preference, poll,
   * and MQTT handshake for each newly discovered account are staggered.
   */
  accountStartStaggerMs?: number;
}

export interface AccountCollector {
  (account: Account, ports: CollectorPorts): Promise<void>;
}

/**
 * Runs one account until it should stop, reconnecting with backoff.
 *
 * Returns when the account is finished with: the process is stopping, or the
 * cloud refused something retrying cannot fix.
 */
export async function collectAccount(
  account: Account,
  ports: CollectorPorts,
): Promise<void> {
  // Hashed, so the log can distinguish accounts without naming anyone. The raw
  // id never reaches a log line.
  const tag = await accountTag(account.id);
  let failures = 0;

  while (!ports.stopping()) {
    let accessToken: string;
    try {
      accessToken = await openToken(ports.keyring, account.id, account.token);
    } catch {
      // A token this instance cannot open is a key problem, not a printer
      // problem, and no amount of retrying changes it.
      ports.log("error", "cannot open the stored token for an account", { account_tag: tag });
      return;
    }

    let username: string;
    try {
      // The MQTT username is no longer carried inside the access token, so it
      // comes from the account endpoint. One HTTP call per session, not per
      // report.
      const { uid } = await preference(hostsFor(account.region), accessToken);
      username = mqttUsernameForUid(uid);
    } catch (cause) {
      if (cause instanceof CloudError && cause.category === "unauthorized-or-expired") {
        await ports.store.markReauthRequired(account.id);
        ports.log("warn", "the cloud refused this account's token", { account_tag: tag });
        return;
      }
      failures += 1;
      ports.log("warn", "could not read the account id", { account_tag: tag });
      if (await sleepOrStop(ports, backoffMs(failures, ports.random))) return;
      continue;
    }

    // HTTP first, every session, because MQTT does not carry a printer's name.
    // This is the same read the cron does, and it is what makes the collector's
    // richer render a superset of the cron's rather than a trade: names and
    // online flags from here, metrics from the reports that follow.
    let baseline: readonly Observation[] = [];
    try {
      const poll = await ports.pollCloud({
        hosts: hostsFor(account.region),
        accessToken,
        deviceIds: account.deviceIds,
        exportJobName: account.exportJobName,
        now: ports.now(),
      });
      if (poll.status === "reauth_required") {
        await ports.store.markReauthRequired(account.id);
        ports.log("warn", "the cloud refused this account's token", { account_tag: tag });
        return;
      }
      baseline = poll.observations;
    } catch {
      // Without a baseline the render would have no name, so this is worth a
      // retry rather than a nameless session.
      failures += 1;
      ports.log("warn", "could not read the printer list", { account_tag: tag });
      if (await sleepOrStop(ports, backoffMs(failures, ports.random))) return;
      continue;
    }

    try {
      const ending = await runAccountSession(account, {
        store: ports.store,
        connect: ports.connect,
        username,
        accessToken,
        clientId: ports.clientId(),
        now: ports.now,
        stopped: ports.stopped,
        baseline,
        onRender: ({ bytes, printers }) => {
          failures = 0;
          ports.log("info", "stored a live render", {
            account_tag: tag,
            bytes,
            printers,
          });
        },
      });

      if (ending.reason === "rejected") {
        // The broker refused the credentials or the subscription. Retrying
        // cannot help, and hammering a rejecting endpoint is what earns a ban.
        await ports.store.markReauthRequired(account.id);
        ports.log("error", "the broker refused this session", { account_tag: tag });
        return;
      }
      ports.log("warn", "live session ended", { account_tag: tag, reason: ending.reason });
    } catch {
      // Reaching the broker failed. The message could name a host, so only the
      // fact is logged.
      ports.log("warn", "could not reach the broker", { account_tag: tag });
    }

    failures += 1;
    if (await sleepOrStop(ports, backoffMs(failures, ports.random))) return;
  }
}

/**
 * Discovers and collects accounts until stopped.
 *
 * Discovery has its own cadence: a healthy MQTT session never resolves, so it
 * cannot be awaited before looking for new enrolments. The live-session map is
 * also the single-connection guard — an account already running or queued for
 * admission is never started again.
 */
export async function collectAll(
  ports: CollectorPorts,
  options: CollectorOptions,
  collect: AccountCollector = collectAccount,
): Promise<void> {
  const sessions = new Map<string, Promise<void>>();
  const queuedIds = new Set<string>();
  const admissionQueue: Account[] = [];
  const localStop = Promise.withResolvers<void>();
  let halting = false;
  let admission: Promise<void> | null = null;
  const sessionPorts: CollectorPorts = {
    ...ports,
    stopping: () => halting || ports.stopping(),
    stopped: Promise.race([ports.stopped, localStop.promise]),
  };

  const startSession = (account: Account): void => {
    let running: Promise<void>;
    running = collect(account, sessionPorts)
      .catch(() => {
        // The account loop normally contains its own operational failures. A
        // truly unexpected one is isolated here so unrelated sessions survive.
        ports.log("error", "an account collection session stopped unexpectedly");
      })
      .finally(() => {
        if (sessions.get(account.id) === running) sessions.delete(account.id);
      });
    sessions.set(account.id, running);
  };

  const startAdmission = (): void => {
    if (admission !== null || halting || ports.stopping()) return;
    admission = (async () => {
      let first = true;
      while (admissionQueue.length > 0 && !halting && !ports.stopping()) {
        if (
          !first &&
          (await waitOrStop(
            sessionPorts,
            options.accountStartStaggerMs ?? ACCOUNT_START_STAGGER_MS,
          ))
        ) {
          return;
        }
        first = false;
        if (halting || ports.stopping()) return;

        const account = admissionQueue.shift();
        if (account === undefined) return;
        queuedIds.delete(account.id);
        if (!sessions.has(account.id)) startSession(account);
      }
    })().finally(() => {
      admission = null;
      if (admissionQueue.length > 0) startAdmission();
    });
  };

  try {
    while (!ports.stopping()) {
      // Every account, not only the ones a cron would consider due: the cutoff
      // that makes the cron stand aside would otherwise hide exactly the
      // accounts this process exists to serve. `dueAccounts` rotates its window
      // by advancing `last_serviced_at`, so only read the remaining headroom or
      // successive rounds would grow past this instance's configured ceiling.
      const room = options.maxAccounts - sessions.size - admissionQueue.length;
      const accounts =
        room <= 0
          ? []
          : await ports.store.dueAccounts(room, Number.MAX_SAFE_INTEGER);
      for (const account of accounts) {
        if (sessions.has(account.id) || queuedIds.has(account.id)) continue;
        queuedIds.add(account.id);
        admissionQueue.push(account);
      }
      startAdmission();
      ports.log("info", "discovered accounts", {
        accounts: accounts.length,
        active: sessions.size,
        queued: admissionQueue.length,
      });

      if (await waitOrStop(ports, options.rediscoverMs)) break;
    }
  } finally {
    // A database/discovery failure must also close already-live sessions before
    // the lease is released. On an ordinary stop this resolves the same signal
    // the process already supplied and is harmless.
    halting = true;
    localStop.resolve();
    admissionQueue.length = 0;
    queuedIds.clear();
    const closing = sessions.size;
    await admission;
    await Promise.allSettled([...sessions.values()]);
    ports.log("info", "finished collecting", { accounts: closing });
  }
}

/** Exponential with full jitter, so restarts do not synchronise into a burst. */
export function backoffMs(failures: number, random: () => number): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

async function sleepOrStop(ports: CollectorPorts, ms: number): Promise<boolean> {
  return waitOrStop(ports, ms);
}

async function waitOrStop(ports: CollectorPorts, ms: number): Promise<boolean> {
  if (ports.stopping()) return true;
  return Promise.race([
    ports.sleep(ms).then(() => ports.stopping()),
    ports.stopped.then(() => true),
  ]);
}

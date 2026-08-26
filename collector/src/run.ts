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

import { preference } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/api";
import { hostsFor } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/hosts";
import { mqttUsernameForUid } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/token";
import { CloudError } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/http";
import type { ByteStream } from "@trmnl-bambulab/core/telemetry/mqtt/client";
import type { Observation } from "@trmnl-bambulab/core/telemetry/types";
import type {
  PollOptions,
  PollResult,
} from "@trmnl-bambulab/core/telemetry/providers/cloud-http";
import { openToken, type Keyring } from "@trmnl-bambulab/core/hosted/crypto";
import { accountTag, type LogDetail } from "@trmnl-bambulab/core/hosted/log";
import type { Account, Store } from "@trmnl-bambulab/core/hosted/store";
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
   * Reserves one cold-handshake slot and returns its idempotent release.
   *
   * `collectAll` supplies the bounded gate. Direct `collectAccount` callers may
   * omit it, which keeps the account loop independently testable.
   */
  acquireHandshake?(): Promise<() => void>;
  /**
   * Scalars only, deliberately.
   *
   * The shared core log type restricts detail to scalars because handing a logger
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
/** At most this many accounts may open tokens and establish subscriptions together. */
export const ACCOUNT_HANDSHAKE_CONCURRENCY = 2;

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
  /** Explicit bound for token open, preference, baseline poll, and MQTT admission. */
  handshakeConcurrency?: number;
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
    const permit = ports.acquireHandshake === undefined
      ? () => undefined
      : await ports.acquireHandshake();
    let permitReleased = false;
    const releasePermit = (): void => {
      if (permitReleased) return;
      permitReleased = true;
      permit();
    };

    try {
      if (ports.stopping()) return;

      let accessToken: string;
      try {
        accessToken = await openToken(ports.keyring, account.id, account.token);
      } catch {
        // A token this instance cannot open is a key problem, not a printer
        // problem, and no amount of retrying changes it.
        ports.log("error", "cannot open the stored token for an account", { account_tag: tag });
        return;
      }
      if (ports.stopping()) return;

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
        releasePermit();
        if (await sleepOrStop(ports, backoffMs(failures, ports.random))) return;
        continue;
      }
      if (ports.stopping()) return;

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
        releasePermit();
        if (await sleepOrStop(ports, backoffMs(failures, ports.random))) return;
        continue;
      }
      if (ports.stopping()) return;

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
          onSubscribed: releasePermit,
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
      releasePermit();
      if (await sleepOrStop(ports, backoffMs(failures, ports.random))) return;
    } finally {
      releasePermit();
    }
  }
}

interface HandshakeGate {
  acquire(): Promise<() => void>;
  close(): void;
}

function createHandshakeGate(limit: number): HandshakeGate {
  let active = 0;
  let closed = false;
  const waiting: Array<(release: () => void) => void> = [];

  const dispatch = (): void => {
    while (!closed && active < limit && waiting.length > 0) {
      const resolve = waiting.shift();
      if (resolve === undefined) return;
      active += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        dispatch();
      });
    }
  };

  return {
    acquire: () =>
      new Promise<() => void>((resolve) => {
        if (closed) {
          resolve(() => undefined);
          return;
        }
        waiting.push(resolve);
        dispatch();
      }),
    close: () => {
      if (closed) return;
      closed = true;
      for (const resolve of waiting.splice(0)) resolve(() => undefined);
    },
  };
}

export function accountConfigurationFingerprint(account: Account): string {
  return JSON.stringify([
    account.id,
    account.region,
    account.token.keyId,
    account.token.nonce,
    account.token.ciphertext,
    account.deviceIds,
    account.maxPayloadBytes,
    account.exportJobName,
    account.reauthRequired,
  ]);
}

interface QueuedAccount {
  account: Account;
  fingerprint: string;
}

interface ManagedSession {
  fingerprint: string;
  stop(): void;
  done: Promise<void>;
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
  if (!Number.isSafeInteger(options.maxAccounts) || options.maxAccounts < 0) {
    throw new Error("maximum accounts must be a non-negative safe integer");
  }
  const handshakeConcurrency =
    options.handshakeConcurrency ?? ACCOUNT_HANDSHAKE_CONCURRENCY;
  if (!Number.isSafeInteger(handshakeConcurrency) || handshakeConcurrency <= 0) {
    throw new Error("handshake concurrency must be a positive safe integer");
  }

  const gate = createHandshakeGate(handshakeConcurrency);
  const sessions = new Map<string, ManagedSession>();
  const queuedById = new Map<string, QueuedAccount>();
  const admissionQueue: QueuedAccount[] = [];
  const localStop = Promise.withResolvers<void>();
  let halting = false;
  let admission: Promise<void> | null = null;
  const admissionPorts: CollectorPorts = {
    ...ports,
    stopping: () => halting || ports.stopping(),
    stopped: Promise.race([ports.stopped, localStop.promise]),
  };

  const startSession = (queued: QueuedAccount): void => {
    const individualStop = Promise.withResolvers<void>();
    let individuallyStopping = false;
    let state: ManagedSession;
    const sessionPorts: CollectorPorts = {
      ...ports,
      acquireHandshake: gate.acquire,
      stopping: () => halting || individuallyStopping || ports.stopping(),
      stopped: Promise.race([ports.stopped, localStop.promise, individualStop.promise]),
    };
    const done = collect(queued.account, sessionPorts)
      .catch(() => {
        // The account loop normally contains its own operational failures. A
        // truly unexpected one is isolated here so unrelated sessions survive.
        ports.log("error", "an account collection session stopped unexpectedly");
      })
      .finally(() => {
        if (sessions.get(queued.account.id) === state) {
          sessions.delete(queued.account.id);
        }
      });
    state = {
      fingerprint: queued.fingerprint,
      stop: () => {
        if (individuallyStopping) return;
        individuallyStopping = true;
        individualStop.resolve();
      },
      done,
    };
    sessions.set(queued.account.id, state);
  };

  const startAdmission = (): void => {
    if (admission !== null || halting || ports.stopping()) return;
    admission = (async () => {
      let first = true;
      while (admissionQueue.length > 0 && !halting && !ports.stopping()) {
        if (
          !first &&
          (await waitOrStop(
            admissionPorts,
            options.accountStartStaggerMs ?? ACCOUNT_START_STAGGER_MS,
          ))
        ) {
          return;
        }
        first = false;
        if (halting || ports.stopping()) return;

        const queued = admissionQueue.shift();
        if (queued === undefined) return;
        if (queuedById.get(queued.account.id) !== queued) continue;
        queuedById.delete(queued.account.id);
        if (!sessions.has(queued.account.id)) startSession(queued);
      }
    })().finally(() => {
      admission = null;
      if (admissionQueue.length > 0) startAdmission();
    });
  };

  try {
    while (!ports.stopping()) {
      const discovered = await ports.store.collectableAccounts(options.maxAccounts);
      const accounts =
        discovered.length <= options.maxAccounts
          ? discovered
          : discovered.slice(0, options.maxAccounts);
      const selected = new Map(
        accounts.map((account) => [account.id, accountConfigurationFingerprint(account)]),
      );

      // Remove no-longer-selected or changed queued work before the admission
      // loop can turn it into a live session.
      for (let index = admissionQueue.length - 1; index >= 0; index -= 1) {
        const queued = admissionQueue[index];
        if (
          queued !== undefined &&
          selected.get(queued.account.id) !== queued.fingerprint
        ) {
          admissionQueue.splice(index, 1);
          if (queuedById.get(queued.account.id) === queued) {
            queuedById.delete(queued.account.id);
          }
        }
      }

      // Every live session owns a stop promise. A changed or evicted session is
      // closed and fully awaited before its replacement is admitted, preventing
      // two MQTT connections from overlapping on one account.
      const closing: Promise<void>[] = [];
      for (const [id, session] of sessions) {
        if (selected.get(id) === session.fingerprint) continue;
        session.stop();
        closing.push(session.done);
      }
      await Promise.allSettled(closing);

      for (const account of accounts) {
        const fingerprint = selected.get(account.id);
        if (fingerprint === undefined) continue;
        if (sessions.get(account.id)?.fingerprint === fingerprint) continue;
        if (queuedById.get(account.id)?.fingerprint === fingerprint) continue;
        const queued = { account, fingerprint };
        queuedById.set(account.id, queued);
        admissionQueue.push(queued);
      }
      startAdmission();
      ports.log("info", "reconciled collectable accounts", {
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
    gate.close();
    admissionQueue.length = 0;
    queuedById.clear();
    const closing = sessions.size;
    for (const session of sessions.values()) session.stop();
    await admission;
    await Promise.allSettled([...sessions.values()].map(({ done }) => done));
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

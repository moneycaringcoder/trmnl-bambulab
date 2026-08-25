/**
 * The collector process: read the environment, build real ports, hand over.
 *
 * Nothing is decided here. Every decision lives in `supervise.ts`, which touches
 * no global and is therefore testable; this file exists to turn environment
 * variables and a signal handler into that module's inputs. Keeping the split
 * strict is deliberate — orchestration that could only be reached by starting a
 * process is orchestration nobody tests.
 *
 * Everything durable lives in Neon, so this process is disposable by design. It
 * listens on nothing, writes no file, and holds no state a restart would miss.
 */

import { Client } from "@neondatabase/serverless";
import { openTlsStream } from "../../bridge/src/mqtt/transport-node.ts";
import { importKeyringFromEnv } from "../../hosted/src/crypto.ts";
import type { LogDetail } from "../../hosted/src/log.ts";
import { NeonStore } from "../../hosted/src/store-neon.ts";
import { takeLease, type LeaseConnection } from "./lease.ts";
import { EX_CONFIG, supervise, type SupervisePorts } from "./supervise.ts";

/** How often the lease confirms it is still ours. */
const HEARTBEAT_MS = 15_000;

/**
 * A deadline for every lease query, enforced by Postgres.
 *
 * Comfortably longer than a healthy round trip and far shorter than the
 * heartbeat, so a stuck query fails and is reported rather than silently holding
 * the one heartbeat slot.
 */
const LEASE_STATEMENT_TIMEOUT_MS = 5_000;

/** A ceiling, so one instance cannot take on more than it was sized for. */
const DEFAULT_MAX_ACCOUNTS = 200;

/**
 * How often a standby asks again.
 *
 * Seconds rather than minutes: this is the gap a planned restart leaves the
 * display un-enriched, and it costs one short-lived Postgres connection each
 * time. Not sub-second, because a wedged holder would otherwise be hammered.
 */
const STANDBY_POLL_MS = 5_000;

/**
 * How long before the account set is read again.
 *
 * Matched to the hosted cron, so a newly enrolled account waits no longer for
 * live telemetry than it already waits for its first HTTP render.
 */
const REDISCOVER_MS = 5 * 60_000;

type Level = "info" | "warn" | "error";

/**
 * One JSON object per line, which is what a log collector wants and what a
 * person can still read.
 *
 * Detail is restricted to scalars by its type, following `hosted/src/log.ts`:
 * handing a logger an arbitrary object is how an account row or a response body
 * reaches a log. Callers still use fixed messages, and an account appears only
 * as `account_tag` — a truncated one-way digest of an account id that is 122
 * random bits, which is what makes an unsalted digest safe here.
 */
function log(level: Level, message: string, detail: LogDetail = {}): void {
  const line = JSON.stringify({
    level,
    message,
    at: new Date().toISOString(),
    ...detail,
  });
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/**
 * A wait that a shutdown cuts short.
 *
 * Every delay in this process is seconds to minutes long — a rediscovery pause,
 * a standby poll, a reconnect backoff — and a signal that had to wait one out
 * would be answered long after the supervisor gave up and sent `SIGKILL`, so the
 * lease would never be given back tidily. The timer is raced against the
 * shutdown instead.
 *
 * The timer keeps a reference deliberately. A standby waiting its turn holds
 * nothing else open, and an unreferenced timer would let Node decide the process
 * had no work left and exit — which is the standby silently giving up. Racing
 * the shutdown is what makes holding the reference safe.
 */
function sleepUntilStopped(ms: number, stopped: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void stopped.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A configuration mistake, distinguished so it can exit differently. */
class ConfigError extends Error {
  readonly guidance: string;

  constructor(message: string, guidance: string) {
    super(message);
    this.name = "ConfigError";
    this.guidance = guidance;
  }
}

function required(name: string, guidance: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${name} is not set`, guidance);
  }
  return value.trim();
}

/**
 * Reads the account ceiling, refusing a value that is not a count.
 *
 * A silently-ignored typo here would let one instance take on far more accounts
 * than the box was sized for, which shows up as memory pressure rather than as a
 * configuration error.
 */
function maxAccounts(): number {
  const raw = process.env.COLLECTOR_MAX_ACCOUNTS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_ACCOUNTS;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      "COLLECTOR_MAX_ACCOUNTS is not a positive whole number",
      `Unset it to use the default of ${DEFAULT_MAX_ACCOUNTS}, or set it to a count.`,
    );
  }
  return parsed;
}

/**
 * Opens one real Postgres session for the lease.
 *
 * The HTTP driver the store uses cannot hold this: each request is its own
 * session, so an advisory lock would be released the moment it returned.
 *
 * The `error` listener is load-bearing, not defensive. A Postgres client emits
 * `error` when the server closes the connection underneath it — a terminated
 * backend, a restart, a network drop — and an unhandled `error` event is an
 * uncaught exception. That killed the process with a raw driver stack trace
 * before the lease's own heartbeat could notice, which meant the deliberate
 * lost-lease path never ran and the operator got a dump instead of a reason.
 * Handling it lets the next heartbeat query fail normally, which is what
 * reports the loss. The driver's message is not logged: it can name a host.
 */
function leaseOpener(databaseUrl: string): () => Promise<LeaseConnection> {
  return async () => {
    const client = new Client(databaseUrl);
    client.on("error", () => {
      log("warn", "the lease connection failed");
    });
    await client.connect();
    // Every query on this connection is a short one — a backend id, a lock, a
    // row count — so a slow one means something is wrong rather than busy. The
    // heartbeat asks one question at a time, so without a deadline a blackholed
    // socket that produces neither an answer nor an error would hold that slot
    // and delay noticing a lost lease until the OS gave up on the TCP
    // connection. Bounding it at the server is the only bound that survives a
    // connection which has stopped talking.
    await client.query(`SET statement_timeout = ${LEASE_STATEMENT_TIMEOUT_MS}`);
    return {
      async scalar(sql, params = []) {
        const result = await client.query(sql, [...params]);
        const row = result.rows[0];
        return row === undefined ? null : Object.values(row as object)[0];
      },
      async close() {
        await client.end();
      },
    };
  };
}

async function main(): Promise<number> {
  const databaseUrl = required(
    "DATABASE_URL",
    "Use the direct Postgres endpoint, not the pooled one. On Neon that is the " +
      "same host without the `-pooler` suffix.",
  );
  required(
    "TOKEN_KEY_CURRENT_ID",
    "Set it to the id of the key that seals new rows, normally `k1`. It must " +
      "match the Worker, or no stored token can be opened.",
  );
  const keyring = await importKeyringFromEnv(process.env).catch((cause: unknown) => {
    throw new ConfigError(
      cause instanceof Error ? cause.message : "the token keys could not be imported",
      "Set TOKEN_KEY_<ID> to the same base64 key material the Worker uses, and " +
        "TOKEN_KEY_CURRENT_ID to that id.",
    );
  });

  // Names this instance in the operator's own logs. Not a secret and not an
  // identity: nothing authenticates with it.
  const instance = process.env.HOSTNAME?.trim() || `collector-${process.pid}`;
  const ceiling = maxAccounts();
  log("info", "collector starting", { instance, max_accounts: ceiling });

  // One shutdown signal every wait and every live session observes, so a stop is
  // answered at the next await rather than at the end of the current delay — and
  // so a session that the broker would otherwise hold open forever is closed.
  const shutdown = Promise.withResolvers<void>();
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "collector stopping", { reason });
    shutdown.resolve();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const ports: SupervisePorts = {
    store: new NeonStore(databaseUrl),
    keyring,
    connect: openTlsStream,
    now: () => Date.now(),
    sleep: (ms) => sleepUntilStopped(ms, shutdown.promise),
    stopping: () => stopping,
    stopped: shutdown.promise,
    log,
    clientId: () => `trmnl-bambulab-collector-${crypto.randomUUID()}`,
    random: () => Math.random(),
    leaseConnect: leaseOpener(databaseUrl),
    takeLease,
    heartbeatMs: HEARTBEAT_MS,
    // Losing the lease has to close the live sessions, not just set a flag: the
    // lock is already gone by the time the heartbeat notices, so a standby may
    // be collecting these very accounts.
    onLeaseLost: () => stop("the lease was lost"),
  };

  return await supervise(ports, {
    instance,
    maxAccounts: ceiling,
    standbyPollMs: STANDBY_POLL_MS,
    rediscoverMs: REDISCOVER_MS,
  });
}

const code = await main().catch((cause: unknown) => {
  if (cause instanceof ConfigError) {
    log("error", cause.message, { guidance: cause.guidance });
    return EX_CONFIG;
  }
  // The message could name a host or a connection string, so only the fact is
  // logged and the detail is left to the operator's own environment.
  log("error", "the collector could not start");
  return 1;
});
process.exit(code);

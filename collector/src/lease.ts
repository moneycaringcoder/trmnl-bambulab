/**
 * A single-holder lease, so two collectors never collect the same accounts.
 *
 * Two instances both holding MQTT for one account means two concurrent
 * connections against that Bambu account and two writers racing on one screen
 * row. The first is what Bambu bans for; the second is what makes a display
 * flicker. Neither is acceptable, and neither needs a cluster to avoid.
 *
 * This is a Postgres advisory lock plus a heartbeat, and nothing more. Postgres
 * ties an advisory lock to the session that took it, so a collector that dies —
 * crashed, killed, powered off — has its lock released by the database when the
 * connection drops, with no timeout to tune and no fencing token to reason
 * about. The standby simply succeeds the next time it asks.
 *
 * The heartbeat exists for the case the lock alone cannot cover: a holder that
 * is still connected but wedged. It writes nothing and reads nothing beyond the
 * lock itself, so a standby can tell a live holder from a stuck one.
 *
 * The Neon HTTP driver cannot hold this, because every HTTP request is its own
 * session and an advisory lock would be released the moment it returned. The
 * lease therefore needs a real connection, which is why it is a separate port
 * from the store rather than a method on it. It must also be a direct
 * connection: a pooler can put two clients on one backend, where the second
 * acquisition re-enters the first's lock and both callers believe they hold it
 * alone. That was measured, not theorised, so `takeLease` proves exclusion at
 * startup instead of trusting it.
 */

/** A lock identifier. Any constant works; it only has to be shared. */
export const COLLECTOR_LOCK_KEY = 0x7472_6d6e;

/**
 * How long a release waits on the connection before giving up on being polite.
 *
 * Short on purpose: this only runs while the process is trying to exit.
 */
const RELEASE_BOUND_MS = 2_000;

export interface LeaseConnection {
  /** Runs a query and returns the first column of the first row. */
  scalar(sql: string, params?: readonly unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

export interface LeaseOptions {
  /** Names this instance, for the operator's benefit only. Never a secret. */
  instanceId: string;
  /** How often to confirm the lock is still ours. */
  heartbeatMs: number;
  now(): number;
  /** Called when the lease is lost, so the caller can stop collecting. */
  onLost(reason: string): void;
}

export type LeaseResult =
  | { kind: "held"; release: () => Promise<void> }
  /** Someone else holds it. Idle and try again; this is not an error. */
  | { kind: "taken" }
  /**
   * The database cannot enforce this lease, so no collector may run. Measured,
   * not assumed: see `takeLease`.
   */
  | { kind: "unusable"; reason: string; guidance: string };

const GUIDANCE =
  "Point the collector at the direct Postgres endpoint rather than the pooled " +
  "one. On Neon that is the same host without the `-pooler` suffix.";

/**
 * Confirms the connection behaves like a session before anything relies on it.
 *
 * Two pure reads, in this order, because a pooler breaks the lease in two
 * different ways and each needs its own question:
 *
 * - Transaction pooling hands each statement whichever backend is free, so the
 *   backend under one connection changes between queries. A lock taken by the
 *   first statement is held by a backend the next statement never sees.
 * - Session multiplexing puts two clients on one backend. There the lock is
 *   real, but it is re-entrant within a session, so the second collector's
 *   acquisition succeeds and both believe they hold it alone.
 *
 * Reads rather than locks deliberately. The obvious test — take the lock twice
 * and see — was tried and is worse than useless on a pooler: `pg_advisory_unlock`
 * is just as likely to land on the wrong backend, so the probe leaks a held lock
 * that then blocks a correctly configured collector until that backend dies.
 * Asking for two backend ids costs nothing and leaves nothing behind.
 */
async function checkSessionIsReal(
  connect: () => Promise<LeaseConnection>,
): Promise<{ ok: true; connection: LeaseConnection } | { ok: false; reason: string }> {
  const connection = await connect();
  try {
    const first = await connection.scalar("SELECT pg_backend_pid()");
    const second = await connection.scalar("SELECT pg_backend_pid()");
    if (first !== second) {
      await connection.close();
      return {
        ok: false,
        reason: "this connection did not stay on one backend between two queries",
      };
    }

    const probe = await connect();
    try {
      const other = await probe.scalar("SELECT pg_backend_pid()");
      if (other === first) {
        await connection.close();
        return { ok: false, reason: "two connections share one backend" };
      }
    } finally {
      await probe.close();
    }
    return { ok: true, connection };
  } catch (cause) {
    // This function's whole promise is that it leaves nothing behind. A probe
    // that throws — the second connection refused, the database gone mid-check —
    // must not strand the first connection open on the way out.
    await connection.close().catch(() => undefined);
    throw cause;
  }
}

/**
 * Takes the lease if it is free, having first proven the lock can exclude.
 *
 * `pg_try_advisory_lock` rather than `pg_advisory_lock`: the blocking form would
 * leave a standby parked inside a query for as long as the holder lives, which
 * looks identical to a hung process and cannot be interrupted cleanly.
 *
 * The proof is why this takes a factory rather than one connection. An advisory
 * lock belongs to a session, so the whole design rests on two collectors getting
 * two sessions — and against a pooler that is false while looking fine. The
 * consequence of missing it is two MQTT connections per Bambu account, which is
 * the thing Bambu bans for, so it is measured rather than assumed.
 */
export async function takeLease(
  connect: () => Promise<LeaseConnection>,
  options: LeaseOptions,
): Promise<LeaseResult> {
  const checked = await checkSessionIsReal(connect);
  if (!checked.ok) return { kind: "unusable", reason: checked.reason, guidance: GUIDANCE };
  const connection = checked.connection;

  const acquired = await connection.scalar("SELECT pg_try_advisory_lock($1)", [
    COLLECTOR_LOCK_KEY,
  ]);
  if (acquired !== true) {
    await connection.close();
    return { kind: "taken" };
  }

  let stopped = false;
  /** True while a heartbeat query is in flight. */
  let checking = false;

  /** Reports the loss exactly once, and stops asking. */
  const lose = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    options.onLost(reason);
  };

  const timer = setInterval(() => {
    void (async () => {
      // One question at a time. Without this, a heartbeat slower than its own
      // interval overlaps itself: several callbacks pass the `stopped` check
      // before any of them finishes, so a single lost lease is reported once per
      // query in flight. Worse, the queued questions then sit in front of the
      // release's unlock on the same connection, and the release gives up on its
      // bound without ever unlocking — so a standby waits for a socket to time
      // out instead of taking over immediately. Both were observed against real
      // Postgres with an aggressive interval.
      if (stopped || checking) return;
      checking = true;
      try {
        // Asking whether the lock is still ours is the whole heartbeat. If the
        // connection has died underneath us this throws, and the caller learns
        // it here rather than by writing to a row it no longer owns.
        const mine = await connection.scalar(
          `SELECT count(*)::int > 0
             FROM pg_locks
            WHERE locktype = 'advisory'
              AND objid = $1
              AND pid = pg_backend_pid()
              AND granted`,
          [COLLECTOR_LOCK_KEY],
        );
        if (mine !== true) lose("the advisory lock is no longer held by this session");
      } catch {
        lose("the lease connection failed");
      } finally {
        checking = false;
      }
    })();
  }, options.heartbeatMs);

  // Node keeps the process alive for a pending timer, and a collector that has
  // lost its lease should be free to exit.
  timer.unref?.();

  return {
    kind: "held",
    release: async () => {
      stopped = true;
      clearInterval(timer);
      // Bounded, because the common reason to release is that something already
      // went wrong with this connection, and a dead client's `end()` can simply
      // never settle. Waiting on it held the whole process open past the point
      // where every other handle had gone, and Node then exited on an unsettled
      // await rather than with the status the caller had chosen.
      //
      // Giving up early is safe: an advisory lock belongs to its session, so a
      // connection that cannot answer has already had its lock freed by Postgres.
      // The polite unlock is an optimisation for the healthy case — it lets a
      // standby take over without waiting for a socket to time out — not a
      // correctness requirement.
      await Promise.race([
        (async () => {
          try {
            await connection.scalar("SELECT pg_advisory_unlock($1)", [COLLECTOR_LOCK_KEY]);
          } finally {
            await connection.close();
          }
        })().catch(() => undefined),
        // Deliberately referenced. An unreferenced timer cannot keep the process
        // alive long enough to win its own race: with the dead connection
        // holding nothing, Node would find the loop empty and exit on an
        // unsettled await instead of with the status the caller chose.
        new Promise<void>((resolve) => {
          setTimeout(resolve, RELEASE_BOUND_MS);
        }),
      ]);
    },
  };
}

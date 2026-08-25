/**
 * The lease, against a scripted Postgres.
 *
 * The properties that only a database can settle are verified separately against
 * real Postgres — that a second session is refused, that a dropped connection
 * frees the lock with no timeout, and that a pooled endpoint is caught. What is
 * tested here is the decision logic around those queries: which shapes are
 * refused, what is closed on each path, and that nothing is left holding a lock
 * after a refusal.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLECTOR_LOCK_KEY, takeLease, type LeaseConnection } from "../src/lease.ts";

interface FakeSession {
  /** Backend id this session reports, per query, oldest first. */
  pids: unknown[];
  /** What `pg_try_advisory_lock` answers. */
  lock?: unknown;
}

interface Recorder {
  connect: () => Promise<LeaseConnection>;
  /** Every statement run, in order, with the session that ran it. */
  statements: { session: number; sql: string }[];
  closed: number[];
  open: () => number;
}

/**
 * Hands out scripted sessions in order.
 *
 * Statements are matched loosely on their leading verb, because the point is
 * which question was asked rather than how it was spelled.
 */
function sessions(script: readonly FakeSession[]): Recorder {
  const statements: { session: number; sql: string }[] = [];
  const closed: number[] = [];
  let handed = 0;

  return {
    statements,
    closed,
    open: () => handed,
    connect: async () => {
      const index = handed;
      handed += 1;
      const plan = script[index];
      if (plan === undefined) throw new Error(`no scripted session ${index}`);
      let pidReads = 0;

      return {
        async scalar(sql: string): Promise<unknown> {
          statements.push({ session: index, sql });
          // `pg_locks` first, always: the heartbeat's query mentions
          // `pg_backend_pid()` too, so matching on the pid first would answer the
          // heartbeat with a backend id and make it look like a lost lease.
          if (sql.includes("pg_locks")) return true;
          if (sql.includes("pg_backend_pid")) {
            const pid = plan.pids[Math.min(pidReads, plan.pids.length - 1)];
            pidReads += 1;
            return pid;
          }
          if (sql.includes("pg_try_advisory_lock")) return plan.lock ?? true;
          if (sql.includes("pg_advisory_unlock")) return true;
          // Anything else: these tests only ask the four questions above.
          return true;
        },
        async close(): Promise<void> {
          closed.push(index);
        },
      };
    },
  };
}

const options = (onLost: (reason: string) => void = () => {}) => ({
  instanceId: "test",
  heartbeatMs: 1_000,
  now: () => 0,
  onLost,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("taking the lease", () => {
  it("holds it when the connection is a real session and the lock is free", async () => {
    const script = sessions([{ pids: [11] }, { pids: [12] }]);
    const result = await takeLease(script.connect, options());

    expect(result.kind).toBe("held");
    // Two sessions opened, and the probe closed again: a lease costs one
    // connection to keep, not two.
    expect(script.open()).toBe(2);
    expect(script.closed).toEqual([1]);
    if (result.kind === "held") await result.release();
  });

  it("reports the lease taken when the lock is held elsewhere", async () => {
    const script = sessions([{ pids: [11], lock: false }, { pids: [12] }]);
    const result = await takeLease(script.connect, options());

    expect(result.kind).toBe("taken");
    // Nothing left open. A standby that leaks a connection per attempt would
    // exhaust the database while doing nothing at all.
    expect(script.closed.sort()).toEqual([0, 1]);
  });

  // Transaction pooling: each statement gets whichever backend is free, so a
  // lock taken by one statement is held by a backend the next never sees.
  it("refuses a connection that moves between backends", async () => {
    const script = sessions([{ pids: [11, 22] }]);
    const result = await takeLease(script.connect, options());

    expect(result.kind).toBe("unusable");
    if (result.kind === "unusable") {
      expect(result.reason).toContain("did not stay on one backend");
      expect(result.guidance).toContain("-pooler");
    }
  });

  // Session multiplexing: two clients land on one backend, where the lock is
  // re-entrant, so both callers believe they hold it alone.
  it("refuses when two connections share one backend", async () => {
    const script = sessions([{ pids: [11] }, { pids: [11] }]);
    const result = await takeLease(script.connect, options());

    expect(result.kind).toBe("unusable");
    if (result.kind === "unusable") expect(result.reason).toContain("share one backend");
  });

  // The earlier implementation proved exclusion by taking the lock twice, and on
  // a pooler `pg_advisory_unlock` lands on whichever backend is free — so the
  // probe stranded a held lock that blocked a correctly configured collector.
  it("never takes a lock while deciding whether locking works", async () => {
    const script = sessions([{ pids: [11] }, { pids: [11] }]);
    await takeLease(script.connect, options());

    const locking = script.statements.filter((entry) => entry.sql.includes("advisory"));
    expect(locking).toEqual([]);
  });

  it("closes both sessions when it refuses", async () => {
    const script = sessions([{ pids: [11] }, { pids: [11] }]);
    await takeLease(script.connect, options());

    expect(script.closed.sort()).toEqual([0, 1]);
  });

  // The refusal paths close both sessions, and a test above pins that. A probe
  // that *throws* is the other way out of the same function, and its promise is
  // the same: leave nothing behind.
  it("closes the first session when the probe fails", async () => {
    const closed: string[] = [];
    let opened = 0;

    const connect = async (): Promise<LeaseConnection> => {
      opened += 1;
      const which = opened === 1 ? "held" : "probe";
      if (which === "probe") throw new Error("the database refused a second connection");
      return {
        async scalar() {
          return 11;
        },
        async close() {
          closed.push(which);
        },
      };
    };

    await expect(takeLease(connect, options())).rejects.toThrow("refused a second connection");
    // Without this the first connection is stranded, holding nothing but a
    // socket, in the one function whose contract is that it costs nothing.
    expect(closed).toEqual(["held"]);
  });

  it("closes the first session when the probe cannot answer", async () => {
    const closed: string[] = [];
    let opened = 0;

    const connect = async (): Promise<LeaseConnection> => {
      opened += 1;
      const isProbe = opened > 1;
      return {
        async scalar() {
          if (isProbe) throw new Error("the connection died mid-check");
          return 11;
        },
        async close() {
          closed.push(isProbe ? "probe" : "held");
        },
      };
    };

    await expect(takeLease(connect, options())).rejects.toThrow("died mid-check");
    // Both, and the probe by its own `finally`.
    expect(closed.sort()).toEqual(["held", "probe"]);
  });

  it("asks only about its own lock key", async () => {
    const script = sessions([{ pids: [11] }, { pids: [12] }]);
    const result = await takeLease(script.connect, options());
    if (result.kind === "held") await result.release();

    // A shared constant is the whole coordination mechanism, so it is worth
    // pinning that the same one is used to take and to release.
    expect(COLLECTOR_LOCK_KEY).toBe(0x7472_6d6e);
    const advisory = script.statements.filter((entry) => entry.sql.includes("advisory"));
    expect(advisory.length).toBeGreaterThanOrEqual(2);
  });
});

describe("holding the lease", () => {
  it("reports a loss when the lock stops being ours", async () => {
    vi.useFakeTimers();
    const lost: string[] = [];
    let stillOurs = true;

    const connect = async (): Promise<LeaseConnection> => ({
      async scalar(sql: string) {
        if (sql.includes("pg_locks")) return stillOurs;
        if (sql.includes("pg_backend_pid")) return connectionCount;
        if (sql.includes("pg_try_advisory_lock")) return true;
        return true;
      },
      async close() {},
    });
    let connectionCount = 0;
    const counting = async (): Promise<LeaseConnection> => {
      connectionCount += 1;
      return await connect();
    };

    const result = await takeLease(counting, options((reason) => lost.push(reason)));
    expect(result.kind).toBe("held");

    stillOurs = false;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(lost.length).toBe(1);
    expect(lost[0]).toContain("no longer held by this session");
  });

  it("reports a loss when the lease connection fails", async () => {
    vi.useFakeTimers();
    const lost: string[] = [];
    let pid = 0;
    let broken = false;

    const connect = async (): Promise<LeaseConnection> => {
      pid += 1;
      const mine = pid;
      return {
        async scalar(sql: string) {
          if (broken) throw new Error("the connection is gone");
          if (sql.includes("pg_backend_pid")) return mine;
          return true;
        },
        async close() {},
      };
    };

    const result = await takeLease(connect, options((reason) => lost.push(reason)));
    expect(result.kind).toBe("held");

    broken = true;
    await vi.advanceTimersByTimeAsync(1_000);

    // A heartbeat that swallowed this would leave a collector running with no
    // lease, which is the one state that must not happen quietly.
    expect(lost).toEqual(["the lease connection failed"]);
  });

  it("stops heartbeating once it has reported a loss", async () => {
    vi.useFakeTimers();
    const lost: string[] = [];
    let pid = 0;
    const connect = async (): Promise<LeaseConnection> => {
      pid += 1;
      const mine = pid;
      return {
        async scalar(sql: string) {
          if (sql.includes("pg_locks")) return false;
          if (sql.includes("pg_backend_pid")) return mine;
          return true;
        },
        async close() {},
      };
    };

    const result = await takeLease(connect, options((reason) => lost.push(reason)));
    expect(result.kind).toBe("held");

    await vi.advanceTimersByTimeAsync(10_000);

    // Reported once, not ten times. The caller is shutting down; a stream of
    // identical errors only obscures why.
    expect(lost.length).toBe(1);
  });

  // The test above passes even with the overlap guard removed, because its query
  // answers instantly. A real one does not: against real Postgres a heartbeat
  // slower than its own interval reported the same loss three times, and the
  // queued questions starved the release's unlock so a standby had to wait for a
  // socket to time out rather than taking over.
  it("asks one question at a time, even when the answer is slow", async () => {
    vi.useFakeTimers();
    const lost: string[] = [];
    let asks = 0;
    // Initialised to a no-op rather than null: it is assigned inside a closure,
    // where narrowing cannot see it, and it is only ever called after a query.
    let answer: (value: unknown) => void = () => {};
    let pid = 0;

    const connect = async (): Promise<LeaseConnection> => {
      pid += 1;
      const mine = pid;
      return {
        async scalar(sql: string) {
          if (sql.includes("pg_locks")) {
            asks += 1;
            // Left pending, the way a query in flight is.
            return await new Promise((resolve) => {
              answer = resolve;
            });
          }
          if (sql.includes("pg_backend_pid")) return mine;
          return true;
        },
        async close() {},
      };
    };

    const result = await takeLease(connect, options((reason) => lost.push(reason)));
    expect(result.kind).toBe("held");

    // Several intervals pass while the first question is still unanswered.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(asks).toBe(1);

    // Now answer it, saying the lock is gone.
    answer(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(lost).toEqual(["the advisory lock is no longer held by this session"]);
  });

  it("stops heartbeating after a release", async () => {
    vi.useFakeTimers();
    const lost: string[] = [];
    let pid = 0;
    let asked = 0;
    const connect = async (): Promise<LeaseConnection> => {
      pid += 1;
      const mine = pid;
      return {
        async scalar(sql: string) {
          if (sql.includes("pg_locks")) {
            asked += 1;
            return true;
          }
          if (sql.includes("pg_backend_pid")) return mine;
          return true;
        },
        async close() {},
      };
    };

    const result = await takeLease(connect, options((reason) => lost.push(reason)));
    if (result.kind !== "held") throw new Error("expected the lease");
    await result.release();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toBe(0);
    expect(lost).toEqual([]);
  });

  // The usual reason to release is that something already went wrong with this
  // connection, so `release` must not depend on it answering. Waiting on a dead
  // client's `end()` held the process open until every other handle had gone,
  // and Node then exited on an unsettled await with a status nobody chose.
  it("gives up on a connection that never answers", async () => {
    vi.useFakeTimers();
    let pid = 0;
    const connect = async (): Promise<LeaseConnection> => {
      pid += 1;
      const mine = pid;
      // Only the first connection is the one kept; the second is the probe, and
      // `takeLease` closes it before returning, so it has to answer.
      const isHeld = mine === 1;
      return {
        async scalar(sql: string) {
          // Still ours, so this test is about the release and nothing else.
          if (sql.includes("pg_locks")) return true;
          if (sql.includes("pg_backend_pid")) return mine;
          if (isHeld && sql.includes("pg_advisory_unlock")) {
            return await new Promise(() => {});
          }
          return true;
        },
        close: isHeld ? () => new Promise(() => {}) : async () => {},
      };
    };

    const result = await takeLease(connect, options());
    if (result.kind !== "held") throw new Error("expected the lease");
    let settled = false;
    const releasing = result.release().then(() => {
      settled = true;
    });

    // Past the bound, so the race is decided by the timer rather than by the
    // connection, which never answers.
    await vi.advanceTimersByTimeAsync(2_500);
    await releasing;
    // Safe to give up: an advisory lock belongs to its session, so a connection
    // that cannot answer has already had its lock freed by Postgres.
    expect(settled).toBe(true);
  });
});

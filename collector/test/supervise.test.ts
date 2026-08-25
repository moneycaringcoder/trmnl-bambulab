/**
 * The orchestration: lease first, collect second, and the exit status.
 *
 * This module had no tests when it lived inside `index.ts`, because reaching it
 * meant starting a process against a real database — and that is how a session
 * which could not be stopped reached review. The behaviour under test is small
 * and entirely about order and exit codes, both of which a restart
 * policy depends on.
 */

import { describe, expect, it } from "vitest";
import type { LeaseConnection, LeaseOptions, LeaseResult } from "../src/lease.ts";
import { EX_CONFIG, EX_LEASE_LOST, supervise, type SupervisePorts } from "../src/supervise.ts";
import type { Account, Store } from "../../hosted/src/store.ts";
import type { Keyring } from "../../hosted/src/crypto.ts";

const OPTIONS = {
  instance: "collector-test",
  maxAccounts: 5,
  standbyPollMs: 10,
  rediscoverMs: 20,
};

interface Harness {
  ports: SupervisePorts;
  /** Every log line, as `level message`. */
  lines: string[];
  /** How many times the account set was read. */
  reads: number;
  released: number;
  /** Ends the run, the way a signal does. */
  stop: () => void;
  /** Fires the lease's own loss callback. */
  lose: (reason: string) => void;
}

/**
 * Builds ports whose lease answers a scripted sequence.
 *
 * `accounts` is what the store returns; the default is none, which is the
 * fresh-deployment case and keeps `collectAll` from needing a broker.
 */
function harness(
  script: readonly LeaseResult["kind"][],
  options: { accounts?: Account[]; unusableReason?: string } = {},
): Harness {
  const lines: string[] = [];
  const shutdown = Promise.withResolvers<void>();
  let stopping = false;
  let reads = 0;
  let released = 0;
  let attempt = 0;
  let onLost: ((reason: string) => void) | null = null;

  const store = {
    async dueAccounts() {
      reads += 1;
      return options.accounts ?? [];
    },
  } as unknown as Store;

  const takeLease = async (
    _connect: () => Promise<LeaseConnection>,
    leaseOptions: LeaseOptions,
  ): Promise<LeaseResult> => {
    onLost = leaseOptions.onLost;
    // The last entry repeats, so a script need not spell out every retry.
    const kind = script[Math.min(attempt, script.length - 1)];
    attempt += 1;
    if (kind === "held") {
      return {
        kind: "held",
        release: async () => {
          released += 1;
        },
      };
    }
    if (kind === "unusable") {
      return {
        kind: "unusable",
        reason: options.unusableReason ?? "two connections share one backend",
        guidance: "Use the direct endpoint.",
      };
    }
    return { kind: "taken" };
  };

  const ports: SupervisePorts = {
    store,
    keyring: {} as Keyring,
    connect: async () => {
      throw new Error("no session should be opened in these tests");
    },
    pollCloud: async () => {
      throw new Error("no cloud read should happen in these tests");
    },
    now: () => 1_000_000,
    sleep: async (ms) => {
      // Real time, but tiny and bounded by the script: the point of these tests
      // is ordering, and the loops need one turn of the clock to advance.
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
    },
    stopping: () => stopping,
    stopped: shutdown.promise,
    log: (level, message) => lines.push(`${level} ${message}`),
    clientId: () => "collector-test",
    random: () => 0.5,
    leaseConnect: async () => {
      throw new Error("no lease connection should be opened in these tests");
    },
    takeLease,
    heartbeatMs: 1_000,
    onLeaseLost: () => {
      stopping = true;
      shutdown.resolve();
    },
  };

  return {
    ports,
    lines,
    get reads() {
      return reads;
    },
    get released() {
      return released;
    },
    stop: () => {
      stopping = true;
      shutdown.resolve();
    },
    lose: (reason) => onLost?.(reason),
  };
}

describe("refusing to run", () => {
  it("exits EX_CONFIG when the database cannot enforce the lease", async () => {
    const test = harness(["unusable"]);
    const code = await supervise(test.ports, OPTIONS);

    expect(code).toBe(EX_CONFIG);
    expect(test.lines).toContain("error this database cannot enforce the collection lease");
  });

  it("reads no account before the lease is settled", async () => {
    const test = harness(["unusable"]);
    await supervise(test.ports, OPTIONS);

    // Touching an account without the lease is the whole thing being prevented.
    expect(test.reads).toBe(0);
    expect(test.released).toBe(0);
  });
});

describe("waiting for the lease", () => {
  it("waits rather than exiting, then takes over", async () => {
    const test = harness(["taken", "taken", "held"]);
    // Once it holds the lease it stays in the rediscovery loop, which is the
    // behaviour a later test pins, so the run has to be ended from outside it.
    setTimeout(test.stop, 40);
    const code = await supervise(test.ports, OPTIONS);

    expect(code).toBe(0);
    expect(test.lines).toContain("info another collector holds the lease");
    expect(test.lines).toContain("info holding the collection lease");
    // In that order: it waited, and only then took over.
    expect(test.lines.indexOf("info another collector holds the lease")).toBeLessThan(
      test.lines.indexOf("info holding the collection lease"),
    );
  });

  it("says it is waiting once, not once per attempt", async () => {
    const test = harness(["taken", "taken", "taken", "held"]);
    setTimeout(test.stop, 60);
    await supervise(test.ports, OPTIONS);

    // A line every few seconds would bury the moment it takes over.
    const said = test.lines.filter((l) => l === "info another collector holds the lease");
    expect(said.length).toBe(1);
    expect(test.lines).toContain("info holding the collection lease");
  });

  it("stops waiting when the process is stopping", async () => {
    const test = harness(["taken"]);
    // Signalled while it waits its turn: nothing to release, nothing collected.
    setTimeout(test.stop, 5);
    const code = await supervise(test.ports, OPTIONS);

    expect(code).toBe(0);
    expect(test.reads).toBe(0);
    expect(test.released).toBe(0);
    expect(test.lines).not.toContain("info holding the collection lease");
  });
});

describe("holding the lease", () => {
  it("keeps looking for accounts rather than exiting when there are none", async () => {
    const test = harness(["held"]);
    setTimeout(test.stop, 40);
    const code = await supervise(test.ports, OPTIONS);

    expect(code).toBe(0);
    // A container that exited here would not be restarted by an `on-failure`
    // policy, and the next person to enrol would get no live telemetry.
    expect(test.reads).toBeGreaterThan(1);
  });

  it("gives the lease back on the way out", async () => {
    const test = harness(["held"]);
    setTimeout(test.stop, 10);
    await supervise(test.ports, OPTIONS);

    expect(test.released).toBe(1);
  });

  it("gives the lease back even when collecting throws", async () => {
    const test = harness(["held"]);
    const failing = {
      async dueAccounts() {
        throw new Error("the database went away");
      },
    } as unknown as Store;

    await expect(
      supervise({ ...test.ports, store: failing }, OPTIONS),
    ).rejects.toThrow("the database went away");
    // Holding a lock after a crash would make a standby wait for the connection
    // to drop rather than taking over immediately.
    expect(test.released).toBe(1);
  });
});

describe("losing the lease", () => {
  it("exits non-zero, so an on-failure policy restarts it", async () => {
    const test = harness(["held"]);
    setTimeout(() => test.lose("the advisory lock is no longer held by this session"), 10);
    const code = await supervise(test.ports, OPTIONS);

    // Exiting zero would leave the container stopped with nothing collecting,
    // because `--restart on-failure` does not restart a clean exit.
    expect(code).toBe(EX_LEASE_LOST);
    expect(code).not.toBe(0);
  });

  it("says so, and stops collecting", async () => {
    const test = harness(["held"]);
    setTimeout(() => test.lose("the lease connection failed"), 10);
    await supervise(test.ports, OPTIONS);

    expect(test.lines).toContain("error lost the collection lease");
    const readsAtLoss = test.reads;
    // Nothing more is read after the loss: the standby owns these accounts now.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(test.reads).toBe(readsAtLoss);
  });

  it("still gives the lease back", async () => {
    const test = harness(["held"]);
    setTimeout(() => test.lose("the lease connection failed"), 10);
    await supervise(test.ports, OPTIONS);

    expect(test.released).toBe(1);
  });
});

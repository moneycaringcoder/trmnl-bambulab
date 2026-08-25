/**
 * Collector admission, discovery, session isolation, and reconnect backoff.
 *
 * The supervisor tests use injected account loops: no token, cloud, broker, or
 * database is reached. This keeps timing deterministic while pinning the two
 * burst-safety properties — cold starts are spaced and reconnects stay bounded.
 */

import { describe, expect, it } from "vitest";
import {
  ACCOUNT_START_STAGGER_MS,
  backoffMs,
  collectAll,
  type CollectorPorts,
} from "../src/run.ts";
import type { Account, Store } from "../../hosted/src/store.ts";
import type { Keyring } from "../../hosted/src/crypto.ts";

/** Full jitter halves the ceiling at worst, so this is the floor of any delay. */
const FIRST_CEILING = 5_000;
const CAP = 5 * 60_000;

describe("backoff", () => {
  it("never returns a delay short enough to be a storm", () => {
    for (let failures = 1; failures <= 40; failures += 1) {
      for (const random of [0, 0.5, 0.999]) {
        const delay = backoffMs(failures, () => random);
        expect(delay).toBeGreaterThanOrEqual(FIRST_CEILING / 2);
      }
    }
  });

  it("climbs with consecutive failures", () => {
    // Compared at a fixed jitter, because the point is the ceiling moving rather
    // than one draw beating another.
    const delays = [1, 2, 3, 4, 5].map((failures) => backoffMs(failures, () => 1));
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThan(delays[index - 1] ?? 0);
    }
  });

  it("stops climbing at the cap", () => {
    // A delay that kept doubling would eventually park a collector for hours,
    // which is indistinguishable from it being dead.
    for (const failures of [20, 100, 1_000]) {
      expect(backoffMs(failures, () => 1)).toBe(CAP);
    }
  });

  it("stays within the cap for every jitter draw", () => {
    for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(backoffMs(50, () => random)).toBeLessThanOrEqual(CAP);
    }
  });

  it("spreads restarts rather than synchronising them", () => {
    // Instances that all restarted together would reconnect together without
    // this, which is the shape that looks like an attack from the far end.
    const draws = [0, 0.2, 0.4, 0.6, 0.8, 0.999].map((random) =>
      backoffMs(4, () => random),
    );
    expect(new Set(draws).size).toBe(draws.length);
  });
});

function account(id: string): Account {
  return {
    id,
    ownerTag: "f".repeat(64),
    region: "global",
    token: { keyId: "k1", nonce: "AAAA", ciphertext: "AAAA" },
    deviceIds: [`${"0".repeat(12)}A1`],
    maxPayloadBytes: 2048,
    exportJobName: false,
    reauthRequired: false,
  };
}

interface CollectionHarness {
  ports: CollectorPorts;
  stop(): void;
}

function collectionHarness(
  dueAccounts: () => Promise<Account[]>,
  sleep: (ms: number) => Promise<void> = async () => undefined,
): CollectionHarness {
  const stopped = Promise.withResolvers<void>();
  let stopping = false;
  return {
    ports: {
      store: { dueAccounts } as unknown as Store,
      keyring: {} as Keyring,
      connect: async () => {
        throw new Error("the injected account collector owns this test");
      },
      pollCloud: async () => {
        throw new Error("the injected account collector owns this test");
      },
      now: () => 1_000_000,
      sleep,
      stopping: () => stopping,
      stopped: stopped.promise,
      log: () => undefined,
      clientId: () => "collector-test",
      random: () => 0.5,
    },
    stop() {
      stopping = true;
      stopped.resolve();
    },
  };
}

describe("account supervision", () => {
  it("discovers a new enrolment while an existing session remains live", async () => {
    const first = account("acct-a");
    const second = account("acct-b");
    let reads = 0;
    const starts: string[] = [];
    const settled: string[] = [];
    let test: CollectionHarness;
    test = collectionHarness(async () => {
      reads += 1;
      return reads === 1 ? [first] : [first, second];
    });

    await collectAll(
      test.ports,
      { maxAccounts: 10, rediscoverMs: 1, accountStartStaggerMs: 0 },
      async (discovered, ports) => {
        starts.push(discovered.id);
        if (discovered.id === second.id) test.stop();
        await ports.stopped;
        settled.push(discovered.id);
      },
    );

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(starts).toEqual([first.id, second.id]);
    expect([...settled].sort()).toEqual([first.id, second.id].sort());
  });

  it("never grows live sessions beyond the configured account ceiling", async () => {
    const accounts = [account("acct-a"), account("acct-b"), account("acct-c")];
    const starts: string[] = [];
    let reads = 0;
    let discoverySleeps = 0;
    let test: CollectionHarness;
    test = collectionHarness(
      async () => {
        const account = accounts[reads];
        reads += 1;
        return account === undefined ? [] : [account];
      },
      async (ms) => {
        if (ms !== 10) return;
        discoverySleeps += 1;
        if (discoverySleeps === 3) test.stop();
      },
    );

    await collectAll(
      test.ports,
      { maxAccounts: 2, rediscoverMs: 10, accountStartStaggerMs: 0 },
      async (discovered, ports) => {
        starts.push(discovered.id);
        await ports.stopped;
      },
    );

    expect(starts).toEqual([accounts[0]?.id, accounts[1]?.id]);
    expect(reads).toBe(2);
  });

  it("does not let one ended account stop an unrelated live session", async () => {
    const live = account("acct-live");
    const ended = account("acct-ended");
    let reads = 0;
    let liveSettled = false;
    let test: CollectionHarness;
    test = collectionHarness(async () => {
      reads += 1;
      if (reads === 1) return [live];
      if (reads === 2) return [live, ended];
      test.stop();
      return [live];
    });

    await collectAll(
      test.ports,
      { maxAccounts: 10, rediscoverMs: 1, accountStartStaggerMs: 0 },
      async (discovered, ports) => {
        if (discovered.id === ended.id) return;
        await ports.stopped;
        liveSettled = true;
      },
    );

    expect(reads).toBeGreaterThanOrEqual(3);
    expect(liveSettled).toBe(true);
  });

  it("spaces cold-start account admission independently of the account ceiling", async () => {
    const accounts = [account("acct-a"), account("acct-b"), account("acct-c")];
    const sleeps: { ms: number; resolve: () => void }[] = [];
    let test: CollectionHarness;
    test = collectionHarness(
      async () => accounts,
      async (ms) => {
        const gate = Promise.withResolvers<void>();
        sleeps.push({ ms, resolve: gate.resolve });
        await gate.promise;
      },
    );
    const starts: string[] = [];
    const admitted = accounts.map(() => Promise.withResolvers<void>());

    const finished = collectAll(
      test.ports,
      { maxAccounts: 200, rediscoverMs: 60_000 },
      async (discovered, ports) => {
        starts.push(discovered.id);
        admitted[starts.length - 1]?.resolve();
        if (starts.length === accounts.length) test.stop();
        await ports.stopped;
      },
    );
    await admitted[0]?.promise;

    expect(starts).toEqual([accounts[0]?.id]);
    const firstAdmission = sleeps.find((entry) => entry.ms === ACCOUNT_START_STAGGER_MS);
    expect(firstAdmission).toBeDefined();
    firstAdmission?.resolve();
    await admitted[1]?.promise;

    expect(starts).toEqual([accounts[0]?.id, accounts[1]?.id]);
    const admissionSleeps = sleeps.filter((entry) => entry.ms === ACCOUNT_START_STAGGER_MS);
    admissionSleeps[1]?.resolve();
    await finished;

    expect(starts).toEqual(accounts.map(({ id }) => id));
  });
});

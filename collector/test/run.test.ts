/**
 * Collector admission, discovery, session isolation, and reconnect backoff.
 *
 * The supervisor tests use injected account loops: no token, cloud, broker, or
 * database is reached. This keeps reconciliation, replacement ordering, and
 * handshake admission deterministic.
 */

import { describe, expect, it } from "vitest";
import {
  ACCOUNT_START_STAGGER_MS,
  ACCOUNT_HANDSHAKE_CONCURRENCY,
  accountConfigurationFingerprint,
  backoffMs,
  collectAll,
  type CollectorPorts,
} from "../src/run.ts";
import type { Account, Store } from "@trmnl-bambulab/core/hosted/store";
import type { Keyring } from "@trmnl-bambulab/core/hosted/crypto";

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
  collectableAccounts: (limit: number) => Promise<Account[]>,
  sleep: (ms: number) => Promise<void> = async () => undefined,
): CollectionHarness {
  const stopped = Promise.withResolvers<void>();
  let stopping = false;
  return {
    ports: {
      store: { collectableAccounts } as unknown as Store,
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
  it("fingerprints every session-affecting field deterministically", () => {
    const base = account("acct-fingerprint");
    base.deviceIds = ["printer-a", "printer-b"];
    const fingerprint = accountConfigurationFingerprint(base);
    expect(
      accountConfigurationFingerprint({
        ...base,
        token: { ...base.token },
        deviceIds: [...base.deviceIds],
      }),
    ).toBe(fingerprint);

    const variants: Account[] = [
      { ...base, id: `${base.id}-changed` },
      { ...base, region: "china" },
      { ...base, token: { ...base.token, keyId: `${base.token.keyId}-changed` } },
      { ...base, token: { ...base.token, nonce: `${base.token.nonce}-changed` } },
      { ...base, token: { ...base.token, ciphertext: `${base.token.ciphertext}-changed` } },
      { ...base, deviceIds: [...base.deviceIds].reverse() },
      { ...base, maxPayloadBytes: base.maxPayloadBytes + 1 },
      { ...base, exportJobName: !base.exportJobName },
      { ...base, reauthRequired: !base.reauthRequired },
    ];
    expect(variants.map(accountConfigurationFingerprint)).not.toContain(fingerprint);
  });

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

  it("evicts outside the bounded selection before admitting its replacement", async () => {
    const first = account("acct-a");
    const retained = account("acct-b");
    const replacement = account("acct-c");
    const events: string[] = [];
    const limits: number[] = [];
    let reads = 0;
    let active = 0;
    let peak = 0;
    let test: CollectionHarness;
    test = collectionHarness(async (limit) => {
      limits.push(limit);
      reads += 1;
      return reads === 1 ? [first, retained] : [retained, replacement];
    });

    await collectAll(
      test.ports,
      { maxAccounts: 2, rediscoverMs: 1, accountStartStaggerMs: 0 },
      async (discovered, ports) => {
        active += 1;
        peak = Math.max(peak, active);
        events.push(`start:${discovered.id}`);
        if (discovered.id === replacement.id) test.stop();
        await ports.stopped;
        events.push(`stop:${discovered.id}`);
        active -= 1;
      },
    );

    expect(limits.every((limit) => limit === 2)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(events.indexOf(`stop:${first.id}`)).toBeLessThan(
      events.indexOf(`start:${replacement.id}`),
    );
    expect(events.filter((event) => event === `start:${retained.id}`)).toHaveLength(1);
  });


  it("keeps an unchanged session and replaces a changed sealed token without overlap", async () => {
    const original = account("acct-token");
    const replacement: Account = {
      ...original,
      token: {
        keyId: "k2",
        nonce: `${original.token.nonce}-replacement`,
        ciphertext: `${original.token.ciphertext}-replacement`,
      },
    };
    const events: string[] = [];
    let reads = 0;
    let test: CollectionHarness;
    test = collectionHarness(async () => {
      reads += 1;
      if (reads === 1) return [original];
      if (reads === 2) return [original];
      return [replacement];
    });

    await collectAll(
      test.ports,
      { maxAccounts: 1, rediscoverMs: 1, accountStartStaggerMs: 0 },
      async (discovered, ports) => {
        events.push(`start:${discovered.token.keyId}`);
        if (discovered.token.keyId === replacement.token.keyId) test.stop();
        await ports.stopped;
        events.push(`stop:${discovered.token.keyId}`);
      },
    );

    expect(events.filter((event) => event === `start:${original.token.keyId}`)).toHaveLength(1);
    expect(events.indexOf(`stop:${original.token.keyId}`)).toBeLessThan(
      events.indexOf(`start:${replacement.token.keyId}`),
    );
  });

  it("treats printer order as session configuration and closes before replacement", async () => {
    const original = account("acct-printers");
    original.deviceIds = ["printer-a", "printer-b"];
    const reordered: Account = { ...original, deviceIds: ["printer-b", "printer-a"] };
    const events: string[] = [];
    let reads = 0;
    let test: CollectionHarness;
    test = collectionHarness(async () => {
      reads += 1;
      return reads === 1 ? [original] : [reordered];
    });

    await collectAll(
      test.ports,
      { maxAccounts: 1, rediscoverMs: 1, accountStartStaggerMs: 0 },
      async (discovered, ports) => {
        const order = discovered.deviceIds.join(",");
        events.push(`start:${order}`);
        if (order === reordered.deviceIds.join(",")) test.stop();
        await ports.stopped;
        events.push(`stop:${order}`);
      },
    );

    expect(events.indexOf(`stop:${original.deviceIds.join(",")}`)).toBeLessThan(
      events.indexOf(`start:${reordered.deviceIds.join(",")}`),
    );
  });

  it.each(["deleted", "reauth-required", "disabled"])(
    "stops a session removed from the collectable set because it is %s",
    async () => {
      const selected = account("acct-removed");
      const events: string[] = [];
      let reads = 0;
      let test: CollectionHarness;
      test = collectionHarness(async () => {
        reads += 1;
        if (reads === 1) return [selected];
        if (reads >= 3) test.stop();
        return [];
      });

      await collectAll(
        test.ports,
        { maxAccounts: 1, rediscoverMs: 1, accountStartStaggerMs: 0 },
        async (discovered, ports) => {
          events.push(`start:${discovered.id}`);
          await ports.stopped;
          events.push(`stop:${discovered.id}`);
        },
      );

      expect(events).toEqual([`start:${selected.id}`, `stop:${selected.id}`]);
    },
  );

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

  it("bounds concurrent handshakes while subscribed sessions stay live", async () => {
    const accounts = [
      account("acct-handshake-a"),
      account("acct-handshake-b"),
      account("acct-handshake-c"),
    ];
    const blockers = new Map(accounts.map(({ id }) => [id, Promise.withResolvers<void>()]));
    const firstWave = Promise.withResolvers<void>();
    const thirdAdmission = Promise.withResolvers<void>();
    let activeHandshakes = 0;
    let peakHandshakes = 0;
    let admissions = 0;
    let test: CollectionHarness;
    test = collectionHarness(
      async () => accounts,
      async (ms) => {
        if (ms > 0 && ms !== ACCOUNT_START_STAGGER_MS) await test.ports.stopped;
      },
    );

    const finished = collectAll(
      test.ports,
      {
        maxAccounts: accounts.length,
        rediscoverMs: 60_000,
        accountStartStaggerMs: 0,
        handshakeConcurrency: ACCOUNT_HANDSHAKE_CONCURRENCY,
      },
      async (discovered, ports) => {
        if (ports.acquireHandshake === undefined) {
          throw new Error("the collector did not provide its handshake gate");
        }
        const release = await ports.acquireHandshake();
        activeHandshakes += 1;
        peakHandshakes = Math.max(peakHandshakes, activeHandshakes);
        admissions += 1;
        if (admissions === ACCOUNT_HANDSHAKE_CONCURRENCY) firstWave.resolve();
        if (admissions === accounts.length) thirdAdmission.resolve();
        await blockers.get(discovered.id)?.promise;
        activeHandshakes -= 1;
        release();
        await ports.stopped;
      },
    );
    await firstWave.promise;
    expect(admissions).toBe(ACCOUNT_HANDSHAKE_CONCURRENCY);
    blockers.get(accounts[0]?.id ?? "")?.resolve();
    await thirdAdmission.promise;
    expect(peakHandshakes).toBe(ACCOUNT_HANDSHAKE_CONCURRENCY);

    test.stop();
    for (const blocker of blockers.values()) blocker.resolve();
    await finished;
  });

});

/**
 * The collector session, driven by a fake broker.
 *
 * The MQTT client is the bridge's own, so these exercise real packet handling
 * over a controlled byte stream rather than a stubbed session. What is under
 * test is the collector's own decisions: when it writes, what it writes, and
 * what it refuses to do.
 *
 * No test waits on a duration. Packets are queued before the session starts, so
 * the client reads them in order, and every assertion awaits either the write it
 * expects or the end of the session. The clock is a number a queued step can
 * move, which is how the coalescing window is crossed without sleeping.
 */

import { describe, expect, it } from "vitest";
import { RENDER_COALESCE_MS, runAccountSession } from "../src/session.ts";
import type { ByteStream } from "../../bridge/src/mqtt/client.ts";
import type { Account, Screen, Store } from "../../hosted/src/store.ts";

const CONNACK_OK = Buffer.from([0x20, 0x02, 0x00, 0x00]);
const SUBACK_OK = Buffer.from([0x90, 0x03, 0x00, 0x01, 0x00]);

/** A serial-shaped id, assembled rather than pasted. */
const DEVICE = `${"0".repeat(12)}A1`;
const OTHER_DEVICE = `${"9".repeat(12)}ZZ`;

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acct-1",
    ownerTag: "f".repeat(64),
    region: "global",
    token: { keyId: "k1", nonce: "AAAA", ciphertext: "AAAA" },
    screenKeyFingerprint: "a".repeat(64),
    deviceIds: [DEVICE],
    maxPayloadBytes: 2048,
    exportJobName: false,
    reauthRequired: false,
    ...overrides,
  };
}

/** A step the broker performs when the client next reads: bytes, or an action. */
type Step = Buffer | (() => void);

/**
 * Replays a fixed script of packets and actions.
 *
 * `read` is a generator, so a step runs only once the client has finished with
 * the packet before it. That gives total ordering without a single delay: an
 * action step lands exactly between two reports. When the script runs out the
 * iteration ends, which the client sees as the broker hanging up, and that is
 * the signal each test awaits.
 */
class ScriptedBroker implements ByteStream {
  readonly written: Buffer[] = [];
  private readonly steps: readonly Step[];

  constructor(steps: readonly Step[]) {
    this.steps = [...steps];
  }

  async *read(): AsyncIterable<Buffer> {
    for (const step of this.steps) {
      if (typeof step === "function") {
        step();
        continue;
      }
      yield step;
    }
  }

  async write(chunk: Buffer): Promise<void> {
    this.written.push(Buffer.from(chunk));
  }

  async close(): Promise<void> {}
}

/** Records writes; anything else is a failure rather than a silent no-op. */
function recordingStore(writes: Screen[]): Store {
  return new Proxy({} as Store, {
    get: (_target, name) => {
      if (name === "writeScreen") {
        return async (_id: string, screen: Screen) => {
          writes.push({ ...screen });
        };
      }
      throw new Error(`the session must not call store.${String(name)}`);
    },
  });
}

/**
 * MQTT's remaining-length varint: seven bits a byte, high bit as continuation.
 *
 * Worth writing properly rather than assuming one byte. A realistic report is
 * about 200 bytes, so a single-byte length silently produces a packet the client
 * cannot parse — and a test that then passes by asserting nothing happened.
 */
function remainingLength(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    const digit = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? digit | 0x80 : digit);
  } while (rest > 0);
  return Buffer.from(bytes);
}

/** A QoS 0 PUBLISH carrying a report for one device. */
function report(deviceId: string, print: Record<string, unknown>): Buffer {
  const topic = Buffer.from(`device/${deviceId}/report`, "utf8");
  const payload = Buffer.from(JSON.stringify({ print }), "utf8");
  const body = Buffer.concat([
    Buffer.from([topic.length >> 8, topic.length & 0xff]),
    topic,
    payload,
  ]);
  return Buffer.concat([Buffer.from([0x30]), remainingLength(body.length), body]);
}

const PRINTING = {
  gcode_state: "RUNNING",
  mc_percent: 42,
  layer_num: 81,
  total_layer_num: 194,
  mc_remaining_time: 76,
  nozzle_temper: 220,
  nozzle_target_temper: 220,
  bed_temper: 60,
  bed_target_temper: 60,
};

interface Run {
  writes: Screen[];
  written: Buffer[];
  finished: Promise<unknown>;
  /** Ends the session the way a lost lease or a signal does. */
  halt: () => void;
}

/** A session that is never asked to stop, for the tests that do not care. */
const NEVER_STOPS = new Promise<void>(() => {});

/**
 * Runs a whole session against a script and resolves when it ends.
 *
 * `steps` may include functions, which run in sequence with the packets — that
 * is how a test moves the clock between reports.
 */
function run(
  steps: Step[],
  options: { account?: Account; stopped?: Promise<void> } = {},
): Run {
  const writes: Screen[] = [];
  const broker = new ScriptedBroker([CONNACK_OK, SUBACK_OK, ...steps]);
  const clock = { now: 1_000_000 };
  const shutdown = Promise.withResolvers<void>();

  const finished = runAccountSession(options.account ?? account(), {
    store: recordingStore(writes),
    connect: async () => broker,
    username: "u_1234567",
    accessToken: "cloud-token",
    clientId: "collector-test",
    now: () => clock.now,
    stopped: options.stopped ?? shutdown.promise,
  });

  return { writes, written: broker.written, finished, halt: shutdown.resolve };
}

/** Moves the injected clock, for a step in a script. */
function advance(clock: { now: number }, ms: number): () => void {
  return () => {
    clock.now += ms;
  };
}

describe("a live session", () => {
  it("renders a report into a stored screen", async () => {
    const session = run([report(DEVICE, PRINTING)]);
    await session.finished;

    expect(session.writes.length).toBe(1);
    const printer = JSON.parse(session.writes[0]?.body ?? "{}").printers?.[0];
    // The whole reason for holding the connection: figures HTTP cannot supply.
    expect(printer?.progress).toBe(42);
    expect(printer?.layer).toBe(81);
    expect(printer?.layers).toBe(194);
    expect(printer?.nozzle).toBe(220);
    expect(printer?.bed).toBe(60);
    expect(printer?.state).toBe("printing");
  });

  it("puts merge variables at the root, with no envelope", async () => {
    const session = run([report(DEVICE, PRINTING)]);
    await session.finished;

    const body = JSON.parse(session.writes[0]?.body ?? "{}");
    // `GET /v1/screen` serves this straight to TRMNL's polling reader, which
    // wants the variables at the root. An envelope here would also make our
    // shape differ from the cron's, which is worse than either shape alone.
    expect(Object.keys(body)).not.toContain("merge_variables");
    expect(Array.isArray(body.printers)).toBe(true);
  });

  it("leaves an absent metric absent rather than writing a zero", async () => {
    const session = run([report(DEVICE, { gcode_state: "IDLE" })]);
    await session.finished;

    // Asserted before anything is read out of it, so a session that wrote
    // nothing fails here rather than passing on an empty string.
    expect(session.writes.length).toBe(1);
    const body = session.writes[0]?.body ?? "";
    expect(body).not.toContain("null");
    const printer = JSON.parse(body).printers?.[0];
    expect(printer?.state).toBe("idle");
    // A fabricated zero is the one thing the display must never show.
    expect(printer?.progress).toBeUndefined();
    expect(printer?.layer).toBeUndefined();
    expect(printer?.nozzle).toBeUndefined();
  });

  // A printing X1 reports every second or two; TRMNL fetches every fifteen
  // minutes. One write per report would spend database rate for nothing.
  it("coalesces a burst of reports, then flushes the last state once", async () => {
    const writes: Screen[] = [];
    let duringBurst = -1;
    const broker = new ScriptedBroker([
      CONNACK_OK,
      SUBACK_OK,
      ...Array.from({ length: 6 }, () => report(DEVICE, PRINTING)),
      // Runs while the session is still live, so this observes the burst rather
      // than the shutdown that follows it.
      () => {
        duringBurst = writes.length;
      },
    ]);

    await runAccountSession(account(), {
      store: recordingStore(writes),
      connect: async () => broker,
      username: "u_1234567",
      accessToken: "cloud-token",
      clientId: "collector-test",
      now: () => 1_000_000,
      stopped: NEVER_STOPS,
    });

    expect(duringBurst).toBe(1);
    // Then one more on the way out: the accumulated state is newer than what
    // was stored, and dropping it would leave a stale screen behind.
    expect(writes.length).toBe(2);
  });

  it("writes again once the coalescing window has passed", async () => {
    const writes: Screen[] = [];
    const clock = { now: 1_000_000 };
    const broker = new ScriptedBroker([
      CONNACK_OK,
      SUBACK_OK,
      report(DEVICE, PRINTING),
      advance(clock, RENDER_COALESCE_MS + 1),
      report(DEVICE, { gcode_state: "RUNNING", mc_percent: 43 }),
    ]);

    await runAccountSession(account(), {
      store: recordingStore(writes),
      connect: async () => broker,
      username: "u_1234567",
      accessToken: "cloud-token",
      clientId: "collector-test",
      now: () => clock.now,
      stopped: NEVER_STOPS,
    });

    expect(writes.length).toBe(2);
    expect(JSON.parse(writes[1]?.body ?? "{}").printers?.[0]?.progress).toBe(43);
  });

  // The reason a held connection beats a poll: a P1 sends only what changed, so
  // the accumulated view is richer than any single report.
  it("accumulates fields across reports rather than replacing them", async () => {
    const writes: Screen[] = [];
    const clock = { now: 1_000_000 };
    const broker = new ScriptedBroker([
      CONNACK_OK,
      SUBACK_OK,
      report(DEVICE, PRINTING),
      advance(clock, RENDER_COALESCE_MS + 1),
      // Mentions only the percentage. The layer and temperatures must survive.
      report(DEVICE, { mc_percent: 55 }),
    ]);

    await runAccountSession(account(), {
      store: recordingStore(writes),
      connect: async () => broker,
      username: "u_1234567",
      accessToken: "cloud-token",
      clientId: "collector-test",
      now: () => clock.now,
      stopped: NEVER_STOPS,
    });

    const latest = JSON.parse(writes.at(-1)?.body ?? "{}").printers?.[0];
    expect(latest?.progress).toBe(55);
    expect(latest?.layer).toBe(81);
    expect(latest?.nozzle).toBe(220);
  });

  it("ignores a report for a printer this account did not choose", async () => {
    const ignored = run([report(OTHER_DEVICE, PRINTING)]);
    await ignored.finished;

    // Attributing another printer's job to this account would be worse than
    // showing nothing at all.
    expect(ignored.writes).toEqual([]);

    // The same packet for a chosen printer does write, so the silence above is
    // the topic filter and not a report the client failed to read.
    const accepted = run([report(DEVICE, PRINTING)]);
    await accepted.finished;
    expect(accepted.writes.length).toBe(1);
  });

  it("refuses to store a payload over the account's ceiling", async () => {
    // The identical report under the real ceiling is stored, so the refusal
    // below is the size check rather than a packet that never arrived.
    const roomy = run([report(DEVICE, PRINTING)]);
    await roomy.finished;
    expect(roomy.writes.length).toBe(1);

    const tight = run([report(DEVICE, PRINTING)], {
      account: account({ maxPayloadBytes: 40 }),
    });
    await tight.finished;

    // Replacing a good render with one TRMNL would reject is worse than keeping
    // the older one, whose age the endpoint already reports.
    expect(tight.writes).toEqual([]);
  });

  it("keeps the session alive when a write fails", async () => {
    const attempts: number[] = [];
    const clock = { now: 1_000_000 };
    const failing = new Proxy({} as Store, {
      get: (_target, name) => {
        if (name === "writeScreen") {
          return async () => {
            attempts.push(clock.now);
            throw new Error("the database is unreachable");
          };
        }
        throw new Error(`unexpected store.${String(name)}`);
      },
    });
    const broker = new ScriptedBroker([
      CONNACK_OK,
      SUBACK_OK,
      report(DEVICE, PRINTING),
      advance(clock, RENDER_COALESCE_MS + 1),
      report(DEVICE, { mc_percent: 44 }),
    ]);

    const ending = await runAccountSession(account(), {
      store: failing,
      connect: async () => broker,
      username: "u_1234567",
      accessToken: "cloud-token",
      clientId: "collector-test",
      now: () => clock.now,
      stopped: NEVER_STOPS,
    });

    // Both reports were attempted, so one bad write did not tear down a healthy
    // subscription. The endpoint keeps serving the previous render meanwhile.
    expect(attempts.length).toBe(2);
    expect(ending.reason).toBe("closed-by-broker");
  });

  it("never sends a packet the broker could act on", async () => {
    const session = run([report(DEVICE, PRINTING)]);
    await session.finished;

    // CONNECT, SUBSCRIBE, PINGREQ, DISCONNECT only. A PUBLISH is 0x30, and the
    // client has no encoder for one.
    const kinds = session.written.map((packet) => (packet[0] ?? 0) & 0xf0);
    expect(kinds).not.toContain(0x30);
    expect(kinds.length).toBeGreaterThan(0);
  });
});

/**
 * A session that cannot be stopped is the failure the lease exists to prevent.
 *
 * When the heartbeat notices the lease is gone, the lock is already gone with
 * it, so a standby is free to start collecting the same accounts. An old process
 * still holding its sessions would then put two MQTT connections on one Bambu
 * account — which Bambu bans for — and two writers on one screen row.
 *
 * The first version of this module discarded the broker's `stop` handle, so none
 * of that could happen. These are the tests that catch it.
 */
describe("stopping a live session", () => {
  /** A broker that stays connected until it is closed, like a healthy one. */
  class OpenBroker implements ByteStream {
    readonly written: Buffer[] = [];
    private readonly queue: Buffer[];
    private waiting: ((value: IteratorResult<Buffer>) => void) | null = null;
    private closed = false;

    constructor(initial: readonly Buffer[]) {
      this.queue = [...initial];
    }

    /**
     * Resolves each time the client asks for another packet.
     *
     * That request is the signal that it has finished with the previous one, so
     * a test can await having-been-processed instead of guessing at microtasks.
     */
    private idle: (() => void)[] = [];

    whenReadyForMore(): Promise<void> {
      return new Promise((resolve) => this.idle.push(resolve));
    }

    read(): AsyncIterable<Buffer> {
      const self = this;
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Buffer>> {
              for (const resolve of self.idle.splice(0)) resolve();
              const next = self.queue.shift();
              if (next !== undefined) return Promise.resolve({ value: next, done: false });
              if (self.closed) return Promise.resolve({ value: undefined, done: true });
              // Exactly what a healthy broker does between reports: nothing.
              return new Promise((resolve) => {
                self.waiting = resolve;
              });
            },
          };
        },
      };
    }

    async write(chunk: Buffer): Promise<void> {
      this.written.push(Buffer.from(chunk));
    }

    async close(): Promise<void> {
      this.closed = true;
      const waiting = this.waiting;
      this.waiting = null;
      waiting?.({ value: undefined, done: true });
    }

    push(chunk: Buffer): void {
      const waiting = this.waiting;
      if (waiting !== null) {
        this.waiting = null;
        waiting({ value: chunk, done: false });
        return;
      }
      this.queue.push(chunk);
    }

    get isClosed(): boolean {
      return this.closed;
    }
  }

  function openSession(now = () => 1_000_000) {
    const writes: Screen[] = [];
    const broker = new OpenBroker([CONNACK_OK, SUBACK_OK]);
    const shutdown = Promise.withResolvers<void>();
    const finished = runAccountSession(account(), {
      store: recordingStore(writes),
      connect: async () => broker,
      username: "u_1234567",
      accessToken: "cloud-token",
      clientId: "collector-test",
      now,
      stopped: shutdown.promise,
    });
    return { writes, broker, finished, halt: shutdown.resolve };
  }

  /**
   * Runs one report, holds its write open, sends a second report, then either
   * halts or does not, and reports what was written.
   *
   * Both halves matter. The halted run shows the queued render is dropped; the
   * unhalted control run shows it would otherwise have been written, which is
   * what makes the first result mean anything.
   */
  async function stuckWriteThenSecondReport(options: { halt: boolean }) {
    const broker = new OpenBroker([CONNACK_OK, SUBACK_OK]);
    const shutdown = Promise.withResolvers<void>();
    const firstWriteStarted = Promise.withResolvers<void>();
    const releaseFirstWrite = Promise.withResolvers<void>();
    const progress: unknown[] = [];
    let calls = 0;

    const store = new Proxy({} as Store, {
      get: (_target, name) => {
        if (name === "writeScreen") {
          return async (_id: string, screen: Screen) => {
            calls += 1;
            progress.push(JSON.parse(screen.body).printers?.[0]?.progress);
            if (calls === 1) {
              // The real signal that a write has begun, rather than a guess at
              // how many turns the client takes to dispatch a packet.
              firstWriteStarted.resolve();
              await releaseFirstWrite.promise;
            }
          };
        }
        throw new Error(`unexpected store.${String(name)}`);
      },
    });

    // Each reading is far enough from the last that the second report would earn
    // its own write rather than being coalesced away.
    let at = 1_000_000;
    const finished = runAccountSession(account(), {
      store,
      connect: async () => broker,
      username: "u_1234567",
      accessToken: "cloud-token",
      clientId: "collector-test",
      now: () => (at += RENDER_COALESCE_MS + 1),
      stopped: shutdown.promise,
    });

    broker.push(report(DEVICE, PRINTING));
    await firstWriteStarted.promise;

    // Arrives while the first write is stuck, so it is left pending.
    broker.push(report(DEVICE, { gcode_state: "RUNNING", mc_percent: 77 }));
    await broker.whenReadyForMore();

    if (options.halt) shutdown.resolve();
    // Releasing the stuck write runs its `finally`, which re-enters `render`
    // for whatever is pending.
    releaseFirstWrite.resolve();
    if (!options.halt) await broker.close();
    await finished;

    return { calls, progress };
  }

  // The guard immediately before `writeScreen` is separate from the one on the
  // observation path, and it is the one that matters when a halt lands while a
  // write is already in flight.
  it("writes the render queued behind a write when it has not been halted", async () => {
    const control = await stuckWriteThenSecondReport({ halt: false });

    // Establishes that the pending render is real and would be written, which is
    // what gives the halted case below its meaning.
    expect(control.calls).toBe(2);
    expect(control.progress).toContain(77);
  });

  it("drops that queued render when the halt landed during the write", async () => {
    const halted = await stuckWriteThenSecondReport({ halt: true });

    // Exactly the row that was already in flight. The queued one belongs to
    // whoever holds the lease now.
    expect(halted.calls).toBe(1);
    expect(halted.progress).not.toContain(77);
  });

  it("ends when asked, even though the broker never would", async () => {
    const session = openSession();
    session.halt();

    // Resolving at all is the assertion. Before the fix this promise stayed
    // pending for as long as the connection lived, which is forever.
    const ending = await session.finished;
    expect(ending.reason).toBeDefined();
  });

  it("closes the connection rather than merely setting a flag", async () => {
    const session = openSession();
    session.halt();
    await session.finished;

    // A flag would leave this socket open, and with it the second MQTT
    // connection Bambu counts against the account.
    expect(session.broker.isClosed).toBe(true);
  });

  it("writes nothing once it has been asked to stop", async () => {
    const session = openSession();
    session.halt();
    await session.finished;

    // Reports arriving after the halt belong to whoever holds the lease now.
    session.broker.push(report(DEVICE, PRINTING));
    await Promise.resolve();
    expect(session.writes).toEqual([]);
  });

  it("does not flush a pending render after a halt", async () => {
    // A report inside the coalescing window leaves a write pending. On an
    // ordinary end that is flushed, because the newest state is worth keeping;
    // on a halt it must not be, because the row is no longer ours to write.
    const session = openSession();
    session.broker.push(report(DEVICE, PRINTING));
    await Promise.resolve();
    session.broker.push(report(DEVICE, { gcode_state: "RUNNING", mc_percent: 99 }));
    session.halt();
    await session.finished;

    expect(session.writes.length).toBeLessThanOrEqual(1);
    for (const write of session.writes) {
      expect(JSON.parse(write.body).printers?.[0]?.progress).not.toBe(99);
    }
  });
});

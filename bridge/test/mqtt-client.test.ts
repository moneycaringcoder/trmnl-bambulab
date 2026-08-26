import { describe, expect, it } from "vitest";
import {
  MqttSession,
  type ByteStream,
  type SessionEnd,
  type Timers,
} from "@trmnl-bambulab/core/telemetry/mqtt/client";
import { PACKET, SUBSCRIBE_FAILURE } from "@trmnl-bambulab/core/telemetry/mqtt/packet";
import { DEVICE_ID, MQTT_USERNAME } from "./synthetic-values.ts";

const TOPIC = `device/${DEVICE_ID}/report`;

// Built at runtime so no credential-shaped literal exists in this file.
const TOKEN = `t${"o".repeat(20)}ken`;

const CONNECT_OPTIONS = {
  clientId: "trmnl-bambulab-test",
  username: MQTT_USERNAME,
  password: TOKEN,
  topics: [TOPIC],
};

function inbound(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags, body.length]), body]);
}

const CONNACK_OK = inbound(PACKET.connack, 0, Buffer.from([0x00, 0x00]));
const SUBACK_OK = inbound(PACKET.suback, 0, Buffer.from([0x00, 0x01, 0x00]));

function report(body: string): Buffer {
  const topic = Buffer.from(TOPIC, "utf8");
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(topic.length, 0);
  return inbound(
    PACKET.publish,
    0,
    Buffer.concat([header, topic, Buffer.from(body, "utf8")]),
  );
}

/**
 * A broker that hands over a scripted sequence of chunks and then ends the
 * stream, recording everything written to it.
 */
class FakeBroker implements ByteStream {
  readonly written: Buffer[] = [];
  closed = false;
  private readonly script: Buffer[];
  private readonly holdOpen: boolean;
  private release: (() => void) | null = null;

  constructor(script: Buffer[], holdOpen = false) {
    this.script = script;
    this.holdOpen = holdOpen;
  }

  async *read(): AsyncIterable<Buffer> {
    for (const chunk of this.script) {
      yield chunk;
    }
    if (this.holdOpen) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
  }

  async write(bytes: Buffer): Promise<void> {
    this.written.push(Buffer.from(bytes));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.release?.();
  }

  /** The first byte of each written packet, as a packet type. */
  sentTypes(): number[] {
    return this.written.map((packet) => (packet[0] as number) >> 4);
  }
}

/**
 * Timers that fire only when a test says so, and that report whether the
 * handshake deadline is still armed.
 */
function controllableTimers(): Timers & {
  fireRepeats(): void;
  fireOnce(): void;
  onceArmed(): boolean;
  onceCalls(): number;
  lastOnceMs(): number | null;
} {
  const repeats: (() => void)[] = [];
  let once: (() => void) | null = null;
  let onceCount = 0;
  let lastDelay: number | null = null;
  return {
    repeat(_everyMs, run) {
      repeats.push(run);
      return () => {
        const at = repeats.indexOf(run);
        if (at >= 0) repeats.splice(at, 1);
      };
    },
    once(afterMs, run) {
      onceCount += 1;
      lastDelay = afterMs;
      once = run;
      return () => {
        if (once === run) once = null;
      };
    },
    fireRepeats() {
      for (const run of [...repeats]) run();
    },
    fireOnce() {
      const run = once;
      once = null;
      run?.();
    },
    onceArmed() {
      return once !== null;
    },
    onceCalls() {
      return onceCount;
    },
    lastOnceMs() {
      return lastDelay;
    },
  };
}

interface Overrides {
  onReport?: (topic: string, payload: Buffer) => void;
  onSubscribed?: () => void;
  timers?: Timers;
  keepAliveSeconds?: number;
}

function runSession(
  broker: FakeBroker,
  overrides: Overrides = {},
): { end: Promise<SessionEnd>; reports: { topic: string; body: string }[] } {
  const reports: { topic: string; body: string }[] = [];
  const session = new MqttSession(broker, {
    ...CONNECT_OPTIONS,
    timers: controllableTimers(),
    onReport: (topic, payload) => reports.push({ topic, body: payload.toString("utf8") }),
    ...overrides,
  });
  return { end: session.run(), reports };
}

describe("a successful session", () => {
  it("connects, subscribes, and delivers reports", async () => {
    const broker = new FakeBroker([CONNACK_OK, SUBACK_OK, report('{"print":{"mc_percent":42}}')]);
    const { end, reports } = runSession(broker);

    expect(await end).toEqual({ reason: "closed-by-broker" });
    expect(broker.sentTypes()).toEqual([PACKET.connect, PACKET.subscribe]);
    expect(reports).toEqual([{ topic: TOPIC, body: '{"print":{"mc_percent":42}}' }]);
  });

  it("does not subscribe before the broker accepts the connection", async () => {
    const broker = new FakeBroker([]);
    await runSession(broker).end;
    expect(broker.sentTypes()).toEqual([PACKET.connect]);
  });

  it("reports the subscription as live exactly once", async () => {
    let live = 0;
    const broker = new FakeBroker([CONNACK_OK, SUBACK_OK, SUBACK_OK]);
    await runSession(broker, { onSubscribed: () => (live += 1) }).end;
    expect(live).toBe(1);
  });

  it("delivers several reports arriving in one chunk", async () => {
    const broker = new FakeBroker([
      CONNACK_OK,
      SUBACK_OK,
      Buffer.concat([report("first"), report("second")]),
    ]);
    const { end, reports } = runSession(broker);

    await end;
    expect(reports.map((entry) => entry.body)).toEqual(["first", "second"]);
  });

  it("answers the keep-alive clock with a ping and nothing else", async () => {
    const timers = controllableTimers();
    const broker = new FakeBroker([CONNACK_OK, SUBACK_OK], true);
    const session = new MqttSession(broker, {
      ...CONNECT_OPTIONS,
      timers,
      onReport: () => undefined,
      onSubscribed: () => {
        timers.fireRepeats();
        timers.fireRepeats();
        void session.stop();
      },
    });

    expect(await session.run()).toEqual({ reason: "closed-by-caller" });
    expect(broker.sentTypes()).toEqual([
      PACKET.connect,
      PACKET.subscribe,
      PACKET.pingreq,
      PACKET.pingreq,
      PACKET.disconnect,
    ]);
  });

  // The bug this pins was found by pointing the client at Bambu's real broker:
  // the handshake deadline stayed armed after the subscription went live and
  // tore down every healthy session at twenty seconds. It was invisible in a
  // test suite and nearly invisible in the log, because reconnecting worked.
  // Sustained reconnect churn is what Bambu bans accounts for.
  it("disarms the handshake deadline once the subscription is live", async () => {
    const timers = controllableTimers();
    const broker = new FakeBroker([CONNACK_OK, SUBACK_OK], true);
    let armedAfterSubscribe = true;

    const session = new MqttSession(broker, {
      ...CONNECT_OPTIONS,
      timers,
      onReport: () => undefined,
      onSubscribed: () => {
        armedAfterSubscribe = timers.onceArmed();
        // Firing it now must do nothing at all, because it is no longer armed.
        timers.fireOnce();
      },
    });

    const end = session.run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(armedAfterSubscribe).toBe(false);

    // Still open: the deadline did not close it.
    expect(broker.closed).toBe(false);
    await session.stop();
    expect(await end).toEqual({ reason: "closed-by-caller" });
  });

  // The deadline still has to do its job when the broker accepts the socket and
  // then says nothing, which is a real failure mode.
  it("still gives up when the handshake is never answered", async () => {
    const timers = controllableTimers();
    const broker = new FakeBroker([], true);
    const session = new MqttSession(broker, {
      ...CONNECT_OPTIONS,
      timers,
      onReport: () => undefined,
    });

    const end = session.run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers.onceArmed()).toBe(true);
    timers.fireOnce();

    expect(await end).toEqual({ reason: "closed-by-caller" });
    expect(broker.closed).toBe(true);
  });

  it("ends a silent subscribed session so its caller can reconnect", async () => {
    const timers = controllableTimers();
    const broker = new FakeBroker([CONNACK_OK, SUBACK_OK], true);
    const subscribed = Promise.withResolvers<void>();
    const session = new MqttSession(broker, {
      ...CONNECT_OPTIONS,
      keepAliveSeconds: 10,
      timers,
      onReport: () => undefined,
      onSubscribed: subscribed.resolve,
    });

    const end = session.run();
    await subscribed.promise;
    expect(timers.onceArmed()).toBe(false);
    expect(timers.onceCalls()).toBe(1);
    timers.fireRepeats();
    timers.fireRepeats();
    timers.fireRepeats();
    expect(broker.closed).toBe(false);
    timers.fireRepeats();

    expect(await end).toEqual({
      reason: "failed",
      detail: "the subscribed broker session became silent",
    });
    expect(broker.closed).toBe(true);
  });

  it("resets the stable inbound-idle clock when a packet arrives", async () => {
    const timers = controllableTimers();
    const broker = new FakeBroker(
      [CONNACK_OK, SUBACK_OK, report('{"print":{"mc_percent":42}}')],
      true,
    );
    let closedAfterTwoPostReportChecks = true;
    let session: MqttSession;
    session = new MqttSession(broker, {
      ...CONNECT_OPTIONS,
      timers,
      onSubscribed: () => {
        timers.fireRepeats();
        timers.fireRepeats();
      },
      onReport: () => {
        timers.fireRepeats();
        timers.fireRepeats();
        closedAfterTwoPostReportChecks = broker.closed;
        void session.stop();
      },
    });

    await session.run();
    expect(closedAfterTwoPostReportChecks).toBe(false);
    // Only the handshake deadline uses a one-shot timer. Reports allocate none.
    expect(timers.onceCalls()).toBe(1);
  });
});

describe("a refused session", () => {
  it("names the reason when the broker rejects the credentials", async () => {
    const broker = new FakeBroker([inbound(PACKET.connack, 0, Buffer.from([0x00, 0x04]))]);
    expect(await runSession(broker).end).toEqual({
      reason: "rejected",
      detail: "the broker refused the connection: the credentials were rejected",
    });
    expect(broker.closed).toBe(true);
  });

  it("names an unrecognized return code without guessing at it", async () => {
    const broker = new FakeBroker([inbound(PACKET.connack, 0, Buffer.from([0x00, 0x63]))]);
    const end = await runSession(broker).end;
    expect(end).toEqual({
      reason: "rejected",
      detail: "the broker refused the connection: an unrecognized reason",
    });
  });

  it("stops when the broker refuses the subscription", async () => {
    const suback = inbound(PACKET.suback, 0, Buffer.from([0x00, 0x01, SUBSCRIBE_FAILURE]));
    const broker = new FakeBroker([CONNACK_OK, suback]);

    expect(await runSession(broker).end).toEqual({
      reason: "rejected",
      detail: "the broker refused 1 of 1 subscriptions",
    });
  });

  it("reports a write failure as a failure rather than throwing", async () => {
    const broken: ByteStream = {
      async *read() {
        // Never reached.
      },
      write: () => Promise.reject(new Error("socket is gone")),
      close: () => Promise.resolve(),
    };
    const session = new MqttSession(broken, {
      ...CONNECT_OPTIONS,
      onReport: () => undefined,
      timers: controllableTimers(),
    });

    expect(await session.run()).toEqual({
      reason: "failed",
      detail: "could not send the connect packet: socket is gone",
    });
  });

  it("reports a malformed packet as a failure and keeps the detail short", async () => {
    const malformed = Buffer.from([PACKET.publish << 4, 0x80, 0x80, 0x80, 0x80, 0x01]);
    const broker = new FakeBroker([malformed]);
    const end = await runSession(broker).end;

    expect(end.reason).toBe("failed");
    if (end.reason !== "failed") throw new Error("unreachable");
    expect(end.detail).toContain("remaining length");
  });
});

describe("secrets", () => {
  // The token is the account's credential. It belongs in the connect packet
  // and nowhere else, least of all in an error a caller might log.
  it("never puts the token in the session result", async () => {
    const broker = new FakeBroker([inbound(PACKET.connack, 0, Buffer.from([0x00, 0x05]))]);
    const end = await runSession(broker).end;
    expect(JSON.stringify(end)).not.toContain(CONNECT_OPTIONS.password);
  });
});

describe("stopping", () => {
  it("is safe to call twice and sends one disconnect", async () => {
    const broker = new FakeBroker([CONNACK_OK, SUBACK_OK], true);
    const session = new MqttSession(broker, {
      ...CONNECT_OPTIONS,
      timers: controllableTimers(),
      onReport: () => undefined,
      onSubscribed: () => {
        void session.stop();
        void session.stop();
      },
    });

    await session.run();
    expect(broker.sentTypes().filter((type) => type === PACKET.disconnect)).toHaveLength(1);
    expect(broker.closed).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  deviceIdFromTopic,
  reportTopic,
  watchCloudMqtt,
} from "../src/providers/cloud-mqtt.ts";
import type { ByteStream } from "../src/mqtt/client.ts";
import { PACKET } from "../src/mqtt/packet.ts";
import type { Observation } from "../src/types.ts";
import { DEVICE_ID, MQTT_USERNAME } from "./synthetic-values.ts";

const OTHER_DEVICE = `${DEVICE_ID}B`;
const TOKEN = `t${"o".repeat(20)}ken`;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function inbound(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags, body.length]), body]);
}

const CONNACK_OK = inbound(PACKET.connack, 0, Buffer.from([0x00, 0x00]));
const SUBACK_OK = inbound(PACKET.suback, 0, Buffer.from([0x00, 0x01, 0x00]));

function report(topic: string, body: string): Buffer {
  const topicBytes = Buffer.from(topic, "utf8");
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(topicBytes.length, 0);
  const payload = Buffer.concat([header, topicBytes, Buffer.from(body, "utf8")]);
  const length: number[] = [];
  let value = payload.length;
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte = byte | 0x80;
    length.push(byte);
  } while (value > 0);
  return Buffer.concat([Buffer.from([PACKET.publish << 4, ...length]), payload]);
}

class ScriptedBroker implements ByteStream {
  readonly written: Buffer[] = [];
  constructor(private readonly script: Buffer[]) {}

  async *read(): AsyncIterable<Buffer> {
    for (const chunk of this.script) yield chunk;
  }

  async write(bytes: Buffer): Promise<void> {
    this.written.push(Buffer.from(bytes));
  }

  async close(): Promise<void> {}

  /** Everything written, as one searchable string. */
  transcript(): string {
    return Buffer.concat(this.written).toString("utf8");
  }
}

async function collect(script: Buffer[], deviceIds = [DEVICE_ID]) {
  const observations: Observation[] = [];
  const broker = new ScriptedBroker(script);
  const { end } = watchCloudMqtt(broker, {
    username: MQTT_USERNAME,
    accessToken: TOKEN,
    deviceIds,
    exportJobName: false,
    clientId: "trmnl-bambulab-test",
    clock: () => NOW,
    onObservation: (observation) => observations.push(observation),
  });
  await end;
  return { observations, broker };
}

describe("reportTopic and deviceIdFromTopic", () => {
  it("round-trip", () => {
    expect(deviceIdFromTopic(reportTopic(DEVICE_ID))).toBe(DEVICE_ID);
  });

  // Attributing a report to the wrong printer would show one printer's job on
  // another's card, which is worse than dropping it.
  it("refuses anything that is not exactly a report topic", () => {
    expect(deviceIdFromTopic(`device/${DEVICE_ID}/request`)).toBeNull();
    expect(deviceIdFromTopic(`device/${DEVICE_ID}`)).toBeNull();
    expect(deviceIdFromTopic(`device/${DEVICE_ID}/report/extra`)).toBeNull();
    expect(deviceIdFromTopic("device//report")).toBeNull();
    expect(deviceIdFromTopic("")).toBeNull();
  });
});

describe("watchCloudMqtt", () => {
  it("turns a report into an observation attributed to the right printer", async () => {
    const { observations } = await collect([
      CONNACK_OK,
      SUBACK_OK,
      report(reportTopic(DEVICE_ID), '{"print":{"mc_percent":42,"layer_num":81}}'),
    ]);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      providerId: "cloud-mqtt",
      printerKey: DEVICE_ID,
      receivedAt: NOW,
      observedAt: null,
      fields: { job: { progress: 42, layer: { current: 81 } } },
    });
  });

  it("subscribes to every chosen printer's report topic", async () => {
    const { broker } = await collect([CONNACK_OK], [DEVICE_ID, OTHER_DEVICE]);
    const transcript = broker.transcript();

    expect(transcript).toContain(reportTopic(DEVICE_ID));
    expect(transcript).toContain(reportTopic(OTHER_DEVICE));
  });

  // The product's central promise. A request topic never appears on the wire.
  it("never writes to a request topic", async () => {
    const { broker } = await collect([
      CONNACK_OK,
      SUBACK_OK,
      report(reportTopic(DEVICE_ID), '{"print":{"mc_percent":42}}'),
    ]);

    expect(broker.transcript()).not.toContain("/request");
    expect(broker.transcript()).not.toContain("pushall");
    expect(broker.written.map((packet) => (packet[0] as number) >> 4)).toEqual([
      PACKET.connect,
      PACKET.subscribe,
    ]);
  });

  it("ignores a report for a printer the user did not choose", async () => {
    const { observations } = await collect([
      CONNACK_OK,
      SUBACK_OK,
      report(reportTopic(OTHER_DEVICE), '{"print":{"mc_percent":99}}'),
    ]);
    expect(observations).toEqual([]);
  });

  it("drops a malformed report without ending the session", async () => {
    const { observations } = await collect([
      CONNACK_OK,
      SUBACK_OK,
      report(reportTopic(DEVICE_ID), "not json at all"),
      report(reportTopic(DEVICE_ID), '{"print":{"mc_percent":7}}'),
    ]);

    expect(observations).toHaveLength(1);
    expect(observations[0]?.fields.job?.progress).toBe(7);
  });

  it("ignores a report with no print object rather than recording an empty one", async () => {
    const { observations } = await collect([
      CONNACK_OK,
      SUBACK_OK,
      report(reportTopic(DEVICE_ID), '{"info":{"command":"get_version"}}'),
    ]);
    expect(observations).toEqual([]);
  });

  it("suppresses the job name unless the user opted in", async () => {
    const script = [
      CONNACK_OK,
      SUBACK_OK,
      report(
        reportTopic(DEVICE_ID),
        '{"print":{"gcode_state":"RUNNING","subtask_name":"Private model"}}',
      ),
    ];

    // Without the opt-in the report still tells us the state, so it is still an
    // observation; it just carries no name.
    const { observations: suppressed } = await collect(script);
    expect(suppressed[0]?.fields.job).toEqual({ state: "printing", rawState: "RUNNING" });

    const exported: Observation[] = [];
    await watchCloudMqtt(new ScriptedBroker(script), {
      username: MQTT_USERNAME,
      accessToken: TOKEN,
      deviceIds: [DEVICE_ID],
      exportJobName: true,
      clientId: "trmnl-bambulab-test",
      clock: () => NOW,
      onObservation: (observation) => exported.push(observation),
    }).end;

    expect(exported[0]?.fields.job?.name).toBe("Private model");
  });

  // A report carrying only a name we are told not to export leaves nothing.
  it("records nothing when the only field present is a suppressed job name", async () => {
    const { observations } = await collect([
      CONNACK_OK,
      SUBACK_OK,
      report(reportTopic(DEVICE_ID), '{"print":{"subtask_name":"Private model"}}'),
    ]);
    expect(observations).toEqual([]);
  });
});

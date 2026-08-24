import { describe, expect, it } from "vitest";
import {
  DISCONNECT,
  MqttProtocolError,
  PACKET,
  PINGREQ,
  PacketReader,
  SUBSCRIBE_FAILURE,
  encodeConnect,
  encodeSubscribe,
} from "../src/mqtt/packet.ts";
import * as packetModule from "../src/mqtt/packet.ts";
import { DEVICE_ID, MQTT_USERNAME } from "./synthetic-values.ts";

const REPORT_TOPIC = `device/${DEVICE_ID}/report`;

// Built at runtime so no credential-shaped literal exists in this file.
const TOKEN = `t${"o".repeat(20)}ken`;

const CONNECT = {
  clientId: "trmnl-bambulab-test",
  username: MQTT_USERNAME,
  password: TOKEN,
  keepAliveSeconds: 60,
};

/** Assembles an inbound packet the way a broker would. */
function inbound(type: number, flags: number, body: Buffer): Buffer {
  const length: number[] = [];
  let value = body.length;
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte = byte | 0x80;
    length.push(byte);
  } while (value > 0);
  return Buffer.concat([Buffer.from([(type << 4) | flags, ...length]), body]);
}

function publish(topic: string, body: string, qos = 0): Buffer {
  const topicBytes = Buffer.from(topic, "utf8");
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(topicBytes.length, 0);
  const parts = [header, topicBytes];
  if (qos > 0) parts.push(Buffer.from([0x00, 0x01]));
  parts.push(Buffer.from(body, "utf8"));
  return inbound(PACKET.publish, qos << 1, Buffer.concat(parts));
}

// The whole point of this module is that it cannot ask a printer to do
// anything. If someone adds a publish encoder, this fails and they have to
// argue with docs/DECISIONS.md D1 rather than with a reviewer's memory.
describe("the read-only guarantee", () => {
  it("exports no way to encode an outbound publish", () => {
    const exported = Object.keys(packetModule);
    expect(exported.filter((name) => /publish|puback|pubrel|pubrec|pubcomp/i.test(name))).toEqual(
      [],
    );
  });

  it("encodes a connect with no will message, which would be a publish", () => {
    const encoded = encodeConnect(CONNECT);
    // Byte 9 is the connect flags: 0x04 is the will flag.
    expect((encoded[9] as number) & 0x04).toBe(0);
  });
});

describe("encodeConnect", () => {
  it("declares MQTT 3.1.1 with a clean session and credentials", () => {
    const encoded = encodeConnect(CONNECT);

    expect(encoded[0]).toBe(PACKET.connect << 4);
    expect(encoded.subarray(4, 8).toString("utf8")).toBe("MQTT");
    expect(encoded[8]).toBe(4);

    const flags = encoded[9] as number;
    expect(flags & 0x80).toBe(0x80);
    expect(flags & 0x40).toBe(0x40);
    expect(flags & 0x02).toBe(0x02);

    expect(encoded.readUInt16BE(10)).toBe(60);
  });

  it("carries the client id, username and password in that order", () => {
    const encoded = encodeConnect(CONNECT);
    const body = encoded.subarray(2).toString("utf8");
    expect(body.indexOf(CONNECT.clientId)).toBeGreaterThan(-1);
    expect(body.indexOf(CONNECT.clientId)).toBeLessThan(body.indexOf(CONNECT.username));
    expect(body.indexOf(CONNECT.username)).toBeLessThan(body.indexOf(CONNECT.password));
  });

  it("refuses a keep-alive that does not fit the wire format", () => {
    expect(() => encodeConnect({ ...CONNECT, keepAliveSeconds: 70_000 })).toThrow(
      MqttProtocolError,
    );
  });

  it("encodes a multi-byte remaining length for a long token", () => {
    const encoded = encodeConnect({ ...CONNECT, password: "x".repeat(400) });
    // A remaining length above 127 continues into a second byte.
    expect((encoded[1] as number) & 0x80).toBe(0x80);
    expect(encoded.length).toBeGreaterThan(400);
  });
});

describe("encodeSubscribe", () => {
  it("uses the mandatory 0x02 header flags and asks for QoS 0", () => {
    const encoded = encodeSubscribe(1, [REPORT_TOPIC]);

    expect(encoded[0]).toBe((PACKET.subscribe << 4) | 0x02);
    expect(encoded.readUInt16BE(2)).toBe(1);
    expect(encoded[encoded.length - 1]).toBe(0);
  });

  it("packs several topic filters into one subscribe", () => {
    const encoded = encodeSubscribe(7, ["device/a/report", "device/b/report"]);
    const body = encoded.toString("utf8");
    expect(body).toContain("device/a/report");
    expect(body).toContain("device/b/report");
  });

  it("refuses a packet identifier of zero, which the specification reserves", () => {
    expect(() => encodeSubscribe(0, ["device/a/report"])).toThrow(MqttProtocolError);
  });

  it("refuses a subscribe with no topics", () => {
    expect(() => encodeSubscribe(1, [])).toThrow(MqttProtocolError);
  });
});

describe("the fixed ping and disconnect packets", () => {
  it("are the two-byte forms the specification defines", () => {
    expect([...PINGREQ]).toEqual([PACKET.pingreq << 4, 0]);
    expect([...DISCONNECT]).toEqual([PACKET.disconnect << 4, 0]);
  });
});

describe("PacketReader", () => {
  it("reads a connack", () => {
    const reader = new PacketReader();
    expect(reader.push(inbound(PACKET.connack, 0, Buffer.from([0x01, 0x00])))).toEqual([
      { kind: "connack", sessionPresent: true, returnCode: 0 },
    ]);
  });

  it("reads a suback and surfaces a refusal", () => {
    const reader = new PacketReader();
    const body = Buffer.from([0x00, 0x05, 0x00, SUBSCRIBE_FAILURE]);
    expect(reader.push(inbound(PACKET.suback, 0, body))).toEqual([
      { kind: "suback", packetId: 5, returnCodes: [0, SUBSCRIBE_FAILURE] },
    ]);
  });

  it("reads a publish and separates topic from payload", () => {
    const reader = new PacketReader();
    const [decoded] = reader.push(publish(REPORT_TOPIC, '{"print":{}}'));

    expect(decoded?.kind).toBe("publish");
    if (decoded?.kind !== "publish") throw new Error("unreachable");
    expect(decoded.topic).toBe(REPORT_TOPIC);
    expect(decoded.payload.toString("utf8")).toBe('{"print":{}}');
    expect(decoded.qos).toBe(0);
  });

  it("reads a pingresp", () => {
    const reader = new PacketReader();
    expect(reader.push(Buffer.from([PACKET.pingresp << 4, 0]))).toEqual([{ kind: "pingresp" }]);
  });

  // TCP splits wherever it likes, and a report split across two segments must
  // not be lost or misread.
  it("reassembles a packet split across chunks", () => {
    const whole = publish("device/a/report", '{"print":{"mc_percent":42}}');
    const reader = new PacketReader();

    for (let cut = 1; cut < whole.length; cut += 1) {
      const fresh = new PacketReader();
      expect(fresh.push(whole.subarray(0, cut))).toEqual([]);
      expect(fresh.push(whole.subarray(cut))).toHaveLength(1);
    }

    expect(reader.push(whole)).toHaveLength(1);
  });

  it("reads several packets arriving in one chunk", () => {
    const reader = new PacketReader();
    const chunk = Buffer.concat([
      publish("device/a/report", "1"),
      publish("device/a/report", "2"),
      Buffer.from([PACKET.pingresp << 4, 0]),
    ]);

    expect(reader.push(chunk).map((packet) => packet.kind)).toEqual([
      "publish",
      "publish",
      "pingresp",
    ]);
    expect(reader.buffered).toBe(0);
  });

  it("holds an incomplete packet and reports how much it is holding", () => {
    const reader = new PacketReader();
    const whole = publish("device/a/report", "hello");
    reader.push(whole.subarray(0, 4));
    expect(reader.buffered).toBe(4);
  });

  it("handles a payload long enough to need a two-byte remaining length", () => {
    const reader = new PacketReader();
    const body = "x".repeat(500);
    const [decoded] = reader.push(publish("device/a/report", body));

    if (decoded?.kind !== "publish") throw new Error("unreachable");
    expect(decoded.payload.toString("utf8")).toBe(body);
  });

  // We subscribe at QoS 0 so this cannot happen, but misreading the header
  // would shift every byte after it and corrupt the rest of the stream.
  it("skips the packet identifier on a higher-QoS publish", () => {
    const reader = new PacketReader();
    const [decoded] = reader.push(publish("device/a/report", "body", 1));

    if (decoded?.kind !== "publish") throw new Error("unreachable");
    expect(decoded.payload.toString("utf8")).toBe("body");
    expect(decoded.qos).toBe(1);
  });

  it("refuses an inbound packet type we never asked for", () => {
    const reader = new PacketReader();
    expect(() => reader.push(inbound(PACKET.subscribe, 0x02, Buffer.from([0, 1])))).toThrow(
      MqttProtocolError,
    );
  });

  it("refuses a truncated connack rather than inventing a return code", () => {
    const reader = new PacketReader();
    expect(() => reader.push(inbound(PACKET.connack, 0, Buffer.from([0x00])))).toThrow(
      MqttProtocolError,
    );
  });

  it("refuses a remaining length longer than four bytes", () => {
    const reader = new PacketReader();
    const malformed = Buffer.from([PACKET.publish << 4, 0x80, 0x80, 0x80, 0x80, 0x01]);
    expect(() => reader.push(malformed)).toThrow(MqttProtocolError);
  });
});

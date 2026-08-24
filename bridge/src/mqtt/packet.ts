/**
 * MQTT 3.1.1 wire format, subscribe-only.
 *
 * This module can encode a CONNECT, a SUBSCRIBE, a PINGREQ and a DISCONNECT,
 * and it can decode a CONNACK, a SUBACK, a PUBLISH and a PINGRESP. That is the
 * complete set needed to watch a printer, and it is deliberately the complete
 * set that exists.
 *
 * **There is no PUBLISH encoder, and there must never be one.** This project
 * never sends a message to a printer, and the cheapest way to keep a promise
 * like that is to make breaking it require writing new code rather than
 * calling existing code. See `docs/DECISIONS.md` D1 and D2. The absence of
 * `encodePublish` is the enforcement mechanism, so if you find yourself adding
 * it, stop.
 *
 * The same absence rules out acknowledging a QoS 1 delivery, which is fine: we
 * subscribe at QoS 0, so the broker has nothing to acknowledge. The decoder
 * still recognizes a higher-QoS packet, because silently misreading its header
 * would corrupt every packet after it.
 *
 * Pure module. No sockets, no timers, no allocation beyond the buffers it is
 * asked to produce.
 */

export const PROTOCOL_NAME = "MQTT";
export const PROTOCOL_LEVEL = 4;

export const PACKET = {
  connect: 1,
  connack: 2,
  publish: 3,
  subscribe: 8,
  suback: 9,
  pingreq: 12,
  pingresp: 13,
  disconnect: 14,
} as const;

/** A SUBACK return code of 0x80 means the broker refused the subscription. */
export const SUBSCRIBE_FAILURE = 0x80;

export type Decoded =
  | { kind: "connack"; sessionPresent: boolean; returnCode: number }
  | { kind: "suback"; packetId: number; returnCodes: number[] }
  | { kind: "publish"; topic: string; payload: Buffer; qos: number }
  | { kind: "pingresp" };

export class MqttProtocolError extends Error {
  constructor(message: string) {
    super(`mqtt protocol error: ${message}`);
    this.name = "MqttProtocolError";
  }
}

/**
 * The CONNACK return codes the specification defines, as sentences a user can
 * act on. Code 5 is the one to expect when a Bambu access token has expired.
 */
export const CONNACK_REASON: Record<number, string> = {
  0: "accepted",
  1: "the broker refused this protocol version",
  2: "the broker rejected the client identifier",
  3: "the broker is unavailable",
  4: "the credentials were rejected",
  5: "this account is not authorized",
};

function encodeRemainingLength(length: number): Buffer {
  if (length < 0 || length > 268_435_455) {
    throw new MqttProtocolError(`remaining length ${length} is outside the encodable range`);
  }
  const bytes: number[] = [];
  let value = length;
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte = byte | 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

/** MQTT strings are UTF-8 with a two-byte big-endian length prefix. */
function encodeString(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  if (body.length > 0xffff) {
    throw new MqttProtocolError("string is longer than the two-byte length prefix allows");
  }
  const framed = Buffer.allocUnsafe(2 + body.length);
  framed.writeUInt16BE(body.length, 0);
  body.copy(framed, 2);
  return framed;
}

export interface ConnectOptions {
  clientId: string;
  username: string;
  /** The Bambu access token, sent verbatim with no `Bearer` prefix. */
  password: string;
  keepAliveSeconds: number;
}

export function encodeConnect(options: ConnectOptions): Buffer {
  const { clientId, username, password, keepAliveSeconds } = options;
  if (keepAliveSeconds < 0 || keepAliveSeconds > 0xffff) {
    throw new MqttProtocolError("keep-alive is outside the two-byte range");
  }

  const variableHeader = Buffer.allocUnsafe(4);
  // Clean session, username and password present. No will: a will message is a
  // publish the broker performs on our behalf, and we do not publish.
  variableHeader.writeUInt8(PROTOCOL_LEVEL, 0);
  variableHeader.writeUInt8(0x80 | 0x40 | 0x02, 1);
  variableHeader.writeUInt16BE(keepAliveSeconds, 2);

  const body = Buffer.concat([
    encodeString(PROTOCOL_NAME),
    variableHeader,
    encodeString(clientId),
    encodeString(username),
    encodeString(password),
  ]);

  return Buffer.concat([
    Buffer.from([PACKET.connect << 4]),
    encodeRemainingLength(body.length),
    body,
  ]);
}

/**
 * Subscribes at QoS 0 only. A higher QoS would oblige us to acknowledge each
 * delivery, and an acknowledgement is a packet sent to the broker's side of
 * the conversation that this module cannot produce. QoS 0 also matches what the
 * product needs: a report we miss is superseded within seconds.
 */
export function encodeSubscribe(packetId: number, topics: readonly string[]): Buffer {
  if (packetId < 1 || packetId > 0xffff) {
    throw new MqttProtocolError("packet identifier must be between 1 and 65535");
  }
  if (topics.length === 0) {
    throw new MqttProtocolError("a subscribe with no topic filter is malformed");
  }

  const packetIdBytes = Buffer.allocUnsafe(2);
  packetIdBytes.writeUInt16BE(packetId, 0);

  const filters = topics.map((topic) => Buffer.concat([encodeString(topic), Buffer.from([0])]));
  const body = Buffer.concat([packetIdBytes, ...filters]);

  return Buffer.concat([
    // The 0x02 low nibble is mandatory for SUBSCRIBE; brokers reject anything else.
    Buffer.from([(PACKET.subscribe << 4) | 0x02]),
    encodeRemainingLength(body.length),
    body,
  ]);
}

export const PINGREQ = Buffer.from([PACKET.pingreq << 4, 0]);
export const DISCONNECT = Buffer.from([PACKET.disconnect << 4, 0]);

interface Framed {
  type: number;
  flags: number;
  payload: Buffer;
  /** Total bytes consumed, including the fixed header. */
  consumed: number;
}

/**
 * Reads one packet frame, or returns null when the buffer does not hold a
 * complete one yet. A partial packet is normal: TCP splits wherever it likes.
 */
function frame(buffer: Buffer): Framed | null {
  if (buffer.length < 2) return null;

  let remaining = 0;
  let multiplier = 1;
  let cursor = 1;
  for (;;) {
    if (cursor >= buffer.length) return null;
    if (cursor > 4) {
      throw new MqttProtocolError("remaining length is longer than four bytes");
    }
    const byte = buffer[cursor] as number;
    remaining += (byte & 0x7f) * multiplier;
    cursor += 1;
    if ((byte & 0x80) === 0) break;
    multiplier *= 128;
  }

  if (buffer.length < cursor + remaining) return null;
  const first = buffer[0] as number;
  return {
    type: first >> 4,
    flags: first & 0x0f,
    payload: buffer.subarray(cursor, cursor + remaining),
    consumed: cursor + remaining,
  };
}

function decodeFrame(framed: Framed): Decoded {
  const { type, flags, payload } = framed;

  if (type === PACKET.connack) {
    if (payload.length < 2) throw new MqttProtocolError("connack is too short");
    return {
      kind: "connack",
      sessionPresent: ((payload[0] as number) & 0x01) === 1,
      returnCode: payload[1] as number,
    };
  }

  if (type === PACKET.suback) {
    if (payload.length < 3) throw new MqttProtocolError("suback is too short");
    return {
      kind: "suback",
      packetId: payload.readUInt16BE(0),
      returnCodes: Array.from(payload.subarray(2)),
    };
  }

  if (type === PACKET.publish) {
    if (payload.length < 2) throw new MqttProtocolError("publish is too short");
    const topicLength = payload.readUInt16BE(0);
    let cursor = 2 + topicLength;
    if (payload.length < cursor) throw new MqttProtocolError("publish topic is truncated");
    const topic = payload.subarray(2, cursor).toString("utf8");

    const qos = (flags >> 1) & 0x03;
    // Present only above QoS 0. We subscribe at 0, so this should never fire;
    // skipping it anyway keeps a surprise from shifting the payload.
    if (qos > 0) {
      if (payload.length < cursor + 2) {
        throw new MqttProtocolError("publish packet identifier is truncated");
      }
      cursor += 2;
    }

    return { kind: "publish", topic, payload: payload.subarray(cursor), qos };
  }

  if (type === PACKET.pingresp) return { kind: "pingresp" };

  throw new MqttProtocolError(`unexpected inbound packet type ${type}`);
}

/**
 * Splits a byte stream into packets across chunk boundaries.
 *
 * Holds at most one incomplete packet. `push` returns everything that became
 * complete, so a caller that receives three reports in one TCP segment gets
 * three packets.
 */
export class PacketReader {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Decoded[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    const packets: Decoded[] = [];
    for (;;) {
      const framed = frame(this.pending);
      if (framed === null) break;
      this.pending = this.pending.subarray(framed.consumed);
      packets.push(decodeFrame(framed));
    }

    // A long-lived subarray keeps the whole original chunk alive, so once the
    // buffer drains, let go of it.
    if (this.pending.length === 0) this.pending = Buffer.alloc(0);
    return packets;
  }

  /** Bytes held back waiting for the rest of a packet. Diagnostics only. */
  get buffered(): number {
    return this.pending.length;
  }
}

/**
 * A subscribe-only MQTT client over any duplex byte stream.
 *
 * The client knows nothing about how the bytes arrive. It is handed a
 * `ByteStream` and drives the protocol over it, which is what lets the same
 * code run on Node's `tls.connect` and on Cloudflare Workers' `connect()` from
 * `cloudflare:sockets`, where an ordinary MQTT library cannot go.
 *
 * What it does: connect, subscribe to a fixed set of report topics, hand each
 * report to a callback, answer the keep-alive clock, and close cleanly.
 *
 * What it cannot do: send anything to a printer. `packet.ts` has no publish
 * encoder, so this is a property of the code rather than a rule to remember.
 *
 * Failure is reported, never papered over. There is no reconnect loop in here:
 * Bambu has previously banned accounts for reconnect storms, so the retry
 * policy belongs to the caller that can see the whole picture, with backoff and
 * jitter. This client connects once and tells you how it ended.
 */

import {
  CONNACK_REASON,
  DISCONNECT,
  PINGREQ,
  PacketReader,
  SUBSCRIBE_FAILURE,
  encodeConnect,
  encodeSubscribe,
} from "./packet.ts";

/** The half-duplex pair every transport reduces to. */
export interface ByteStream {
  read(): AsyncIterable<Buffer>;
  write(bytes: Buffer): Promise<void>;
  close(): Promise<void>;
}

/**
 * Scheduling, injected rather than reached for.
 *
 * Node and the Workers runtime disagree about what a timer handle is, and a
 * test wants to control the clock without patching globals. Both problems go
 * away if the session is handed two functions that each return their own
 * cancel.
 */
export interface Timers {
  repeat(everyMs: number, run: () => void): () => void;
  once(afterMs: number, run: () => void): () => void;
}

export const systemTimers: Timers = {
  repeat(everyMs, run) {
    const handle = setInterval(run, everyMs);
    return () => clearInterval(handle);
  },
  once(afterMs, run) {
    const handle = setTimeout(run, afterMs);
    return () => clearTimeout(handle);
  },
};

export interface ReportHandler {
  (topic: string, payload: Buffer): void;
}

export interface SessionOptions {
  clientId: string;
  username: string;
  /** The Bambu access token. Never logged, never included in an error. */
  password: string;
  topics: readonly string[];
  keepAliveSeconds?: number;
  /**
   * How long to wait for a CONNACK or a SUBACK before giving up. A broker that
   * accepts the TCP connection and then says nothing is a real failure mode.
   */
  handshakeTimeoutMs?: number;
  onReport: ReportHandler;
  /** Called once when the subscription is live, so the caller can mark health. */
  onSubscribed?: () => void;
  /** Defaults to `systemTimers`. A test supplies its own. */
  timers?: Timers;
}

export type SessionEnd =
  | { reason: "closed-by-broker" }
  | { reason: "closed-by-caller" }
  | { reason: "rejected"; detail: string }
  | { reason: "failed"; detail: string };

/**
 * Bambu's own guidance is not to hammer the broker. Sixty seconds is long
 * enough to be quiet and short enough that a dead connection is noticed within
 * one push cycle.
 */
export const DEFAULT_KEEP_ALIVE_SECONDS = 60;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
/**
 * MQTT allows some scheduling latitude around keep-alive traffic. A subscribed
 * session that receives no packet for one and a half keep-alive periods is
 * treated as half-open and reconnected by its caller.
 */
export const INBOUND_IDLE_KEEP_ALIVE_MULTIPLE = 1.5;
const INBOUND_IDLE_CHECKS = Math.ceil(INBOUND_IDLE_KEEP_ALIVE_MULTIPLE * 2);

export class MqttSession {
  private readonly stream: ByteStream;
  private readonly options: SessionOptions;
  private readonly reader = new PacketReader();
  private readonly timers: Timers;
  private cancelKeepAlive: (() => void) | null = null;
  private cancelHandshakeDeadline: (() => void) | null = null;
  private stopping = false;
  private subscribed = false;
  private inboundIdleChecks = 0;
  private inboundIdleTimedOut = false;

  constructor(stream: ByteStream, options: SessionOptions) {
    this.stream = stream;
    this.options = options;
    this.timers = options.timers ?? systemTimers;
  }

  /**
   * Runs the session to completion. Resolves with how it ended rather than
   * throwing, because every ending here is an expected operational state that
   * the caller has to act on.
   */
  async run(): Promise<SessionEnd> {
    const keepAliveSeconds = this.options.keepAliveSeconds ?? DEFAULT_KEEP_ALIVE_SECONDS;

    try {
      await this.stream.write(
        encodeConnect({
          clientId: this.options.clientId,
          username: this.options.username,
          password: this.options.password,
          keepAliveSeconds,
        }),
      );
    } catch (cause) {
      return { reason: "failed", detail: `could not send the connect packet: ${describe(cause)}` };
    }

    // Covers the handshake only, and is cancelled the moment the subscription
    // goes live. It has to be cancelled there rather than in the `finally`
    // below, because `finally` does not run until the session is already over:
    // leaving it armed tore down every healthy connection at twenty seconds and
    // reconnected, which is the reconnect churn Bambu bans accounts for. It went
    // unnoticed until the client was pointed at the real broker, because
    // reconnecting worked.
    this.cancelHandshakeDeadline = this.timers.once(
      this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      () => {
        // Nothing to unwind but the socket: an unanswered handshake leaves no
        // state worth preserving.
        void this.stop();
      },
    );

    try {
      return await this.pump(keepAliveSeconds);
    } catch (cause) {
      return { reason: "failed", detail: describe(cause) };
    } finally {
      this.cancelHandshakeDeadline?.();
      this.cancelHandshakeDeadline = null;
      this.cancelKeepAlive?.();
      this.cancelKeepAlive = null;
    }
  }

  /** Asks for a clean shutdown. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    // DISCONNECT is a courtesy, not a requirement, so a failure to send it
    // must not prevent the socket from closing.
    try {
      await this.stream.write(DISCONNECT);
    } catch {
      // Intentionally ignored.
    }
    await this.stream.close().catch(() => undefined);
  }

  private async pump(keepAliveSeconds: number): Promise<SessionEnd> {
    for await (const chunk of this.stream.read()) {
      for (const packet of this.reader.push(chunk)) {
        if (this.subscribed) this.inboundIdleChecks = 0;
        if (packet.kind === "connack") {
          if (packet.returnCode !== 0) {
            const reason = CONNACK_REASON[packet.returnCode] ?? "an unrecognized reason";
            await this.stop();
            return { reason: "rejected", detail: `the broker refused the connection: ${reason}` };
          }

          await this.stream.write(encodeSubscribe(1, this.options.topics));
          this.cancelKeepAlive = this.timers.repeat(
            // Ping comfortably inside the window. The same stable clock checks
            // inbound liveness without allocating a timer for every report.
            Math.max(1_000, (keepAliveSeconds * 1000) / 2),
            () => {
              void this.stream.write(PINGREQ).catch(() => undefined);
              if (!this.subscribed || this.stopping) return;
              this.inboundIdleChecks += 1;
              if (this.inboundIdleChecks <= INBOUND_IDLE_CHECKS) return;
              this.inboundIdleTimedOut = true;
              void this.stop();
            },
          );
          continue;
        }

        if (packet.kind === "suback") {
          const refused = packet.returnCodes.filter((code) => code === SUBSCRIBE_FAILURE).length;
          if (refused > 0) {
            await this.stop();
            return {
              reason: "rejected",
              detail: `the broker refused ${refused} of ${packet.returnCodes.length} subscriptions`,
            };
          }
          // The handshake is over, so its deadline must stop being armed. This
          // is the line whose absence killed a healthy session every twenty
          // seconds.
          this.cancelHandshakeDeadline?.();
          this.cancelHandshakeDeadline = null;
          if (!this.subscribed) {
            this.subscribed = true;
            this.options.onSubscribed?.();
          }
          continue;
        }

        if (packet.kind === "publish") {
          this.options.onReport(packet.topic, packet.payload);
        }
        // A pingresp needs no action beyond having arrived.
      }
    }

    if (this.inboundIdleTimedOut) {
      return { reason: "failed", detail: "the subscribed broker session became silent" };
    }
    return this.stopping ? { reason: "closed-by-caller" } : { reason: "closed-by-broker" };
  }
}

/**
 * A cause is turned into a short sentence and never into a dump. The stream
 * error from a TLS failure can name the host and carry the request detail, and
 * this string reaches logs.
 */
function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return "an unknown error";
}

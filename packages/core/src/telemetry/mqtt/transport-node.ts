/**
 * A Node TLS transport for the subscribe-only MQTT session.
 *
 * The only Node-specific file in `src/mqtt/`. Everything above it works on a
 * byte stream, so the hosted tier can supply a `connect()` socket from
 * `cloudflare:sockets` instead without touching the protocol code.
 *
 * TLS defaults are never touched. Bambu's cloud broker presents a publicly
 * trusted certificate for `*.mqtt.bambulab.com`, so ordinary system trust and
 * ordinary hostname verification are exactly right, and there is no option
 * anywhere in this project to weaken either. A connection that cannot be
 * verified fails.
 */

import { connect, type TLSSocket } from "node:tls";
import type { ByteStream } from "./client.ts";

export interface TlsTarget {
  host: string;
  port: number;
  /** How long to wait for the TLS handshake before giving up. */
  timeoutMs?: number;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Opens the socket and resolves once TLS is established and verified.
 *
 * Rejects with a short sentence. A Node TLS error can carry the certificate
 * chain and the peer detail, and this message reaches logs.
 */
export async function openTlsStream(target: TlsTarget): Promise<ByteStream> {
  const timeoutMs = target.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const pending = connect({
      host: target.host,
      port: target.port,
      // Explicit rather than implicit, so that deleting this line reads as the
      // deliberate act it would be.
      rejectUnauthorized: true,
      servername: target.host,
    });

    const timer = setTimeout(() => {
      pending.destroy();
      reject(new Error(`TLS handshake to ${target.host} did not complete in time`));
    }, timeoutMs);

    pending.once("secureConnect", () => {
      clearTimeout(timer);
      if (!pending.authorized) {
        const reason = pending.authorizationError?.message ?? "the certificate was not accepted";
        pending.destroy();
        reject(new Error(`refusing an unverified TLS connection to ${target.host}: ${reason}`));
        return;
      }
      resolve(pending);
    });

    pending.once("error", (cause: Error) => {
      clearTimeout(timer);
      reject(new Error(`could not reach ${target.host}: ${cause.message}`));
    });
  });

  return {
    read() {
      // A Node socket is already an async iterable of chunks, which is the
      // whole reason the session was written against one.
      return socket as AsyncIterable<Buffer>;
    },

    write(bytes: Buffer) {
      return new Promise<void>((resolve, reject) => {
        socket.write(bytes, (cause) => {
          if (cause) reject(new Error(`could not write to ${target.host}: ${cause.message}`));
          else resolve();
        });
      });
    },

    close() {
      return new Promise<void>((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.end();
      });
    },
  };
}

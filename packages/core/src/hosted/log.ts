/**
 * Structured logging for the hosted Worker.
 *
 * Workers Logs indexes JSON fields, so every event is one JSON object on one
 * line rather than terminal-oriented text. `detail` deliberately admits only
 * scalar values. Handing a logger an arbitrary object is how an account row or
 * a response body reaches a log, and excluding both at the type boundary is a
 * cheaper safeguard than hoping review notices.
 *
 * Nothing here makes sensitive text safe. Callers still use fixed messages and
 * must never pass a token, email, device id or webhook URL as a scalar detail.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogDetail = Record<string, string | number | boolean | null>;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, detail?: LogDetail): void;
  info(message: string, detail?: LogDetail): void;
  warn(message: string, detail?: LogDetail): void;
  error(message: string, detail?: LogDetail): void;
}

export function createLogger(level: LogLevel, write: (line: string) => void = defaultWrite): Logger {
  const threshold = RANK[level];

  function emit(at: LogLevel, message: string, detail?: LogDetail): void {
    if (RANK[at] < threshold) return;
    write(
      JSON.stringify({
        ...(detail ?? {}),
        timestamp: new Date().toISOString(),
        level: at,
        message,
      }),
    );
  }

  return {
    debug: (message, detail) => emit("debug", message, detail),
    info: (message, detail) => emit("info", message, detail),
    warn: (message, detail) => emit("warn", message, detail),
    error: (message, detail) => emit("error", message, detail),
  };
}

/**
 * A stable correlation label that reveals no account id.
 *
 * The first 64 bits of SHA-256 are short enough to scan in logs and leave a
 * negligible collision risk at this service's scale. Hashing is deliberately
 * one-way: the label is for joining events from one account, not identifying
 * the person behind it. It is not an authentication primitive.
 *
 * Unsalted, which is safe only while the input cannot be enumerated. That is
 * why account ids come from `newAccountId` in `crypto.ts` and are 122 random
 * bits. If a future onboarding flow ever set an id to an email or a sequence
 * number, this label would become trivially reversible and would then be an
 * account identifier sitting in logs, which `AGENTS.md` forbids.
 */
export async function accountTag(accountId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountId)),
  );
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function defaultWrite(line: string): void {
  console.log(line);
}

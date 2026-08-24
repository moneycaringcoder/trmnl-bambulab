/**
 * The bridge's log.
 *
 * A long-running process needs a log, and a log about printers is exactly the
 * kind of thing a user pastes into an issue. So this one is built to be
 * pasteable: identifiers arrive already masked, and there is no code path that
 * accepts a token, a webhook URL, an account email, or a raw report body.
 *
 * `detail` is deliberately a `Record<string, string | number | boolean | null>`
 * rather than `unknown`. Handing a log an arbitrary object is how a response
 * body ends up on disk, and a type that cannot carry one is a cheaper
 * safeguard than a review that has to notice.
 */

import { stdout } from "node:process";
import { LOG_LEVELS } from "../setup/config.ts";

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogDetail = Record<string, string | number | boolean | null>;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, detail?: LogDetail): void;
  info(message: string, detail?: LogDetail): void;
  warn(message: string, detail?: LogDetail): void;
  error(message: string, detail?: LogDetail): void;
}

/**
 * One line per event: an ISO timestamp, the level, the message, then
 * `key=value` pairs. Not JSON, because the first reader is a person tailing a
 * terminal rather than a log aggregator, and a value containing a space is
 * quoted so the shape survives anyway.
 */
export function createLogger(level: LogLevel, write: (line: string) => void = defaultWrite): Logger {
  const threshold = RANK[level];

  function emit(at: LogLevel, message: string, detail?: LogDetail): void {
    if (RANK[at] < threshold) return;
    const stamp = new Date().toISOString();
    let line = `${stamp} ${at.padEnd(5)} ${message}`;
    if (detail !== undefined) {
      for (const [key, value] of Object.entries(detail)) {
        const rendered = value === null ? "-" : String(value);
        line += / |"/.test(rendered) ? ` ${key}=${JSON.stringify(rendered)}` : ` ${key}=${rendered}`;
      }
    }
    write(line);
  }

  return {
    debug: (message, detail) => emit("debug", message, detail),
    info: (message, detail) => emit("info", message, detail),
    warn: (message, detail) => emit("warn", message, detail),
    error: (message, detail) => emit("error", message, detail),
  };
}

function defaultWrite(line: string): void {
  stdout.write(`${line}\n`);
}

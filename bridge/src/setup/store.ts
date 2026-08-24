/**
 * Reading and writing `bridge/.env`.
 *
 * The file holds the Bambu Cloud token and the TRMNL
 * webhook URL, so it is written atomically at mode 0600: a reader either sees
 * the old file or the complete new one, and never a half-written credential.
 *
 * `bridge/.env` is git-ignored and is a forbidden path in
 * `scripts/secret-scan.sh`, which is why the config lives there rather than in
 * a JSON file next to the source.
 */

import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { configFromEnv, parseEnv, serializeEnv, type BridgeConfig, type ConfigResult } from "./config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** `bridge/.env`, resolved from this module so the cwd does not matter. */
export const configPath = path.resolve(here, "..", "..", ".env");

/** Relative form, for messages. An absolute path leaks the user's home directory. */
export const configLabel = "bridge/.env";

export function configExists(): boolean {
  return existsSync(configPath);
}

export function readConfigText(): string | null {
  return existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
}

/** `null` when there is no config file yet. */
export function loadConfig(): ConfigResult | null {
  const text = readConfigText();
  return text === null ? null : configFromEnv(parseEnv(text));
}

/** Atomic, 0600. The temporary file lives in the same directory so the rename cannot cross devices. */
export function writeConfigText(text: string): void {
  const temporary = `${configPath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, configPath);
  } catch (cause) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw cause;
  }
}

export function saveConfig(config: BridgeConfig): void {
  writeConfigText(serializeEnv(config));
}

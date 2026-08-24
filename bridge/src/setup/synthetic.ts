/**
 * The synthetic payload used to prove the TRMNL plugin is wired up before any
 * real telemetry flows.
 *
 * It is a committed, hand-authored merged fixture: no serial, no address, no
 * account, no captured job name. Sending it tells the user whether their
 * webhook URL and templates work, and tells TRMNL nothing about their printer.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SYNTHETIC_FIXTURE = path.resolve(
  here,
  "..",
  "..",
  "fixtures",
  "merged",
  "printing.synthetic.json",
);

export interface SyntheticPayload {
  /** Exactly what TRMNL receives. */
  body: { merge_variables: unknown };
  serialized: string;
  bytes: number;
}

export function loadSyntheticPayload(): SyntheticPayload {
  const mergeVariables: unknown = JSON.parse(readFileSync(SYNTHETIC_FIXTURE, "utf8"));
  const body = { merge_variables: mergeVariables };
  const serialized = JSON.stringify(body);
  return { body, serialized, bytes: Buffer.byteLength(serialized, "utf8") };
}

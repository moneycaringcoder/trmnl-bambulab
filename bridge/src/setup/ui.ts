/**
 * Terminal output for the setup CLI.
 *
 * Plain ASCII, no dependencies, no color: this runs over SSH, in a container,
 * and in a scrollback that people paste into issues. Nothing printed here may
 * contain a secret; masking happens at the call site, in `mask.ts`.
 */

import { stdout } from "node:process";

export function say(text = ""): void {
  stdout.write(`${text}\n`);
}

export function heading(text: string): void {
  stdout.write(`\n${text}\n${"-".repeat(text.length)}\n`);
}

export function step(text: string): void {
  stdout.write(`  ${text}\n`);
}

export function good(text: string): void {
  stdout.write(`  ok    ${text}\n`);
}

export function warn(text: string): void {
  stdout.write(`  warn  ${text}\n`);
}

export function bad(text: string): void {
  stdout.write(`  fail  ${text}\n`);
}

/** A wrapped instruction block: what went wrong, then what to do next. */
export function advise(message: string, guidance: string): void {
  stdout.write(`\n${message}\n${guidance}\n`);
}

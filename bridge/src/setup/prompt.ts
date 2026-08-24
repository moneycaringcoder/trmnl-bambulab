/**
 * Terminal input for the setup CLI.
 *
 * A hidden prompt is used for every secret. A secret read here is returned to
 * the caller and never stored, echoed, logged, or written to a file by this
 * module.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { SetupError, CANCELLED } from "./errors.ts";

const MAX_ATTEMPTS = 5;

const TOO_MANY = new SetupError(
  "Too many invalid answers in a row.",
  "Nothing was written. Run `pnpm setup` again when you have the value at hand.",
);

export async function ask(question: string, fallback?: string): Promise<string> {
  // An empty default is shown as no default at all, not as "()".
  const suffix = fallback === undefined || fallback === "" ? "" : ` (${fallback})`;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer === "" && fallback !== undefined ? fallback : answer;
  } finally {
    rl.close();
  }
}

/**
 * Reads a line without echoing it. Requires a TTY: without one there is no way
 * to stop the value appearing on screen and in scrollback, so this refuses
 * rather than leaking.
 */
export async function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY) {
    throw new SetupError(
      "This step needs to read a secret without showing it, and this is not an interactive terminal.",
      "Run `pnpm setup` directly in a terminal. Do not pipe input into it, and do not pass a secret as a command-line argument.",
    );
  }

  stdout.write(`${question}: `);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          cleanup();
          stdout.write("\n");
          reject(CANCELLED);
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    stdin.on("data", onData);
  });
}

export async function askYesNo(question: string, fallback: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const answer = (await ask(question, fallback ? "yes" : "no")).toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    stdout.write("  Answer yes or no.\n");
  }
  throw TOO_MANY;
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

export async function askChoice<T>(question: string, choices: Choice<T>[]): Promise<T> {
  stdout.write(`${question}\n`);
  choices.forEach((choice, index) => {
    stdout.write(`  ${index + 1}) ${choice.label}\n`);
    if (choice.hint !== undefined) stdout.write(`     ${choice.hint}\n`);
  });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const answer = await ask("Choice", "1");
    const index = Number(answer);
    const choice = Number.isInteger(index) ? choices[index - 1] : undefined;
    if (choice !== undefined) return choice.value;
    stdout.write(`  Enter a number between 1 and ${choices.length}.\n`);
  }
  throw TOO_MANY;
}

export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; guidance: string };

/**
 * Asks until the answer validates. Each rejection prints what was wrong and
 * what to do about it, so a wrong answer is never a dead end.
 */
export async function askValid<T>(
  question: string,
  validate: (raw: string) => Validation<T>,
  options: { secret?: boolean; fallback?: string } = {},
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const raw =
      options.secret === true
        ? await askSecret(question)
        : await ask(question, options.fallback);
    const result = validate(raw);
    if (result.ok) return result.value;
    stdout.write(`  ${result.message}\n  ${result.guidance}\n`);
  }
  throw TOO_MANY;
}

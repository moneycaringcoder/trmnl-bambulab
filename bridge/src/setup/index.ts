/**
 * `pnpm setup` — the entry point for the setup CLI.
 *
 *   pnpm setup                     interactive configuration
 *   pnpm setup doctor              re-verify the saved config, change nothing
 *   pnpm setup reauth              sign in again and replace only the token
 *   pnpm setup webhook             set only the TRMNL webhook URL
 *   pnpm run setup doctor --push   also send one synthetic TRMNL push
 *
 * Note the `run` in that last line. `setup` is also one of pnpm's own
 * commands, so a bare `pnpm setup doctor --push` has its flag eaten by pnpm's
 * option parser before the script ever sees it. `pnpm run` disambiguates, and
 * so does `pnpm setup doctor -- --push`.
 *
 * The CLI never takes a secret as a command-line argument: process arguments
 * are visible to every user on the machine.
 */

import process from "node:process";
import { runDoctor } from "./doctor.ts";
import { runReauth } from "./reauth.ts";
import { runWebhook } from "./webhook.ts";
import { runSetup } from "./flow.ts";
import { SetupError } from "./errors.ts";
import { advise, say } from "./ui.ts";

const USAGE = [
  "Usage:",
  "  pnpm setup                      configure the bridge interactively",
  "  pnpm setup doctor               check the saved configuration",
  "  pnpm run setup doctor --push    check it and send one test push",
  "  pnpm setup reauth               sign in again and refresh the token",
  "  pnpm setup webhook              set the TRMNL webhook URL",
  "",
  "Docs: README.md",
];

async function main(): Promise<number> {
  const [command = "setup", ...rest] = process.argv.slice(2);

  switch (command) {
    case "setup":
      await runSetup();
      return 0;
    case "doctor":
      return await runDoctor(rest);
    case "reauth":
      await runReauth();
      return 0;
    case "webhook":
      await runWebhook();
      return 0;
    case "help":
    case "-h":
    case "--help":
      for (const line of USAGE) say(line);
      return 0;
    default:
      say(`Unknown command: ${command}`);
      say();
      for (const line of USAGE) say(line);
      return 2;
  }
}

process.on("SIGINT", () => {
  say();
  say("Cancelled. Nothing was written.");
  process.exit(130);
});

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof SetupError) {
    advise(error.message, error.guidance);
    process.exitCode = error.cancelled ? 130 : 1;
  } else {
    // The message may name a path or a host; it never carries a secret,
    // because every secret-bearing failure is a SetupError or a CloudError.
    advise(
      `Setup stopped: ${error instanceof Error ? error.message : String(error)}`,
      "Nothing further was written. Run `pnpm setup doctor` to see the current state, or `pnpm setup` to start over.",
    );
    process.exitCode = 1;
  }
}

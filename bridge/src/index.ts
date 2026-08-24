/**
 * `pnpm start`.
 *
 * Loads `bridge/.env`, refuses to guess when it is missing or incomplete, and
 * runs until interrupted. Every failure here ends in an instruction, because
 * the person reading it is the person who has to fix it.
 */

import process from "node:process";
import { runBridge } from "./bridge/run.ts";
import { createLogger } from "./bridge/log.ts";
import { canPush } from "./setup/config.ts";
import { configLabel, loadConfig } from "./setup/store.ts";

async function main(): Promise<number> {
  const loaded = loadConfig();
  if (loaded === null) {
    process.stderr.write(
      `No configuration found at ${configLabel}.\nRun \`pnpm setup\` to create it.\n`,
    );
    return 1;
  }

  if (!loaded.ok) {
    process.stderr.write(`${configLabel} is not usable:\n\n`);
    for (const problem of loaded.problems) {
      process.stderr.write(`  ${problem.path}: ${problem.message}\n    ${problem.guidance}\n`);
    }
    return 1;
  }

  const config = loaded.config;
  if (!canPush(config)) {
    process.stderr.write(
      "No TRMNL webhook URL is set, so the bridge has nowhere to push.\n" +
        "Run `pnpm setup webhook` to add it.\n",
    );
    return 1;
  }

  const logger = createLogger(config.logLevel);
  const { promise: until, resolve: stop } = Promise.withResolvers<void>();

  // Two signals, one shutdown. A second interrupt exits immediately, because a
  // process that ignores a repeated Ctrl-C is worse than one that stops rudely.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(130);
      stopping = true;
      logger.info("shutting down", { signal });
      stop();
    });
  }

  await runBridge({ config, logger, until });
  return 0;
}

process.exitCode = await main();

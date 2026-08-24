/**
 * `pnpm setup webhook` — set or replace only the TRMNL webhook URL.
 *
 * Setup lets a new user finish without a webhook, because the TRMNL Private
 * Plugin usually does not exist yet at that point. This command fills it in
 * afterwards without touching anything else in the file.
 */

import { askWebhookUrl, sendTestPayload } from "./flow.ts";
import { patchEnv } from "./config.ts";
import { SetupError } from "./errors.ts";
import { askYesNo } from "./prompt.ts";
import { configLabel, loadConfig, readConfigText, writeConfigText } from "./store.ts";
import { good, heading, say, step } from "./ui.ts";

const NO_CONFIG = new SetupError(
  `There is no ${configLabel} yet, so there is nothing to add a webhook to.`,
  "Run `pnpm setup` first.",
);

export async function runWebhook(): Promise<void> {
  const loaded = loadConfig();
  if (loaded === null) throw NO_CONFIG;

  heading("TRMNL webhook");
  step("Open your TRMNL Private Plugin, choose the Webhook strategy, and copy its Webhook URL.");
  step("It is a credential: anyone holding it can write to your display.");
  say();

  const webhookUrl = await askWebhookUrl();
  const text = readConfigText();
  if (text === null) throw NO_CONFIG;
  writeConfigText(patchEnv(text, { TRMNL_WEBHOOK_URL: webhookUrl }));
  good(`Saved to ${configLabel}. Nothing else in the file changed.`);

  if (loaded.ok && (await askYesNo("Send a synthetic test payload now?", true))) {
    await sendTestPayload({ ...loaded.config.trmnl, webhookUrl });
  }
}

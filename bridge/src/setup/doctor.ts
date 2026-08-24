/**
 * `pnpm setup doctor` — re-verify the saved configuration and report per-provider
 * health. It changes nothing: no file is written, no printer command is sent,
 * and no TRMNL push is made unless `--push` is passed, because a push spends
 * part of the account's hourly budget.
 */

import { hostsFor } from "../providers/bambu-cloud/hosts.ts";
import { listDevices } from "../providers/bambu-cloud/api.ts";
import { tokenState } from "../providers/bambu-cloud/token.ts";
import { describeCloudError } from "./cloud-session.ts";
import { summarizeConfig, type BridgeConfig } from "./config.ts";
import { SetupError } from "./errors.ts";
import { maskIdentifier } from "./mask.ts";
import { configLabel, loadConfig } from "./store.ts";
import { loadSyntheticPayload } from "./synthetic.ts";
import { advise, bad, good, heading, say, step, warn } from "./ui.ts";
import { pushPayload } from "./webhook-push.ts";
import { validateWebhookUrl } from "./webhook-url.ts";

const NO_CONFIG = new SetupError(
  `There is no ${configLabel} yet, so there is nothing to check.`,
  "Run `pnpm setup` to create one.",
);

/** Resolves to the process exit code: 0 when every configured provider is healthy. */
export async function runDoctor(argv: string[]): Promise<number> {
  const push = argv.includes("--push");

  const loaded = loadConfig();
  if (loaded === null) throw NO_CONFIG;

  heading("Configuration");
  if (!loaded.ok) {
    for (const problem of loaded.problems) {
      bad(`${problem.path}: ${problem.message}`);
      step(`      ${problem.guidance}`);
    }
    say();
    step(`Fix ${configLabel} by hand, or run \`pnpm setup\` to rebuild it.`);
    return 1;
  }

  const config = loaded.config;
  for (const line of summarizeConfig(config)) step(line);

  const failures = [await checkCloud(config), await checkTrmnl(config, push)].reduce(
    (total, value) => total + value,
    0,
  );

  heading("Verdict");
  if (failures === 0) {
    good("Every configured provider answered.");
    return 0;
  }
  bad(`${failures} check(s) failed. Each failure above says what to do next.`);
  return 1;
}

async function checkCloud(config: BridgeConfig): Promise<number> {
  heading("Bambu Cloud");

  const state = tokenState(config.cloud.accessToken, Date.now());
  if (state.kind === "expired") {
    bad(`reauth_required — the token expired on ${new Date(state.expiresAt).toISOString().slice(0, 10)}.`);
    advise(
      "The bridge cannot read your printers until the token is replaced.",
      "Run `pnpm setup reauth` to sign in again.",
    );
    return 1;
  }
  if (state.kind === "expiring-soon") {
    warn(`The token expires on ${new Date(state.expiresAt).toISOString().slice(0, 10)}.`);
  }
  if (state.kind === "unknown-expiry") {
    // Routine, not a fault: an opaque token carries no claims to read.
    warn("The token has no readable expiry, so expiry will only surface as a refused request.");
  }

  const hosts = hostsFor(config.cloud.region);
  try {
    const devices = await listDevices(hosts, config.cloud.accessToken);
    good(`Cloud answered; ${devices.length} printer(s) bound to the account.`);

    let missing = 0;
    for (const wanted of config.cloud.deviceIds) {
      const match = devices.find((device) => device.id === wanted);
      if (match === undefined) {
        bad(`A chosen printer (${maskIdentifier(wanted)}) is no longer bound to this account.`);
        missing += 1;
        continue;
      }
      if (match.online === false) {
        warn(`${match.name ?? "unnamed"} is offline according to the cloud.`);
      } else {
        good(`${match.name ?? "unnamed"} found (${maskIdentifier(match.id)}).`);
      }
    }
    if (missing > 0) {
      advise(
        "Those printers cannot be shown.",
        "Re-add them in Bambu Handy, or run `pnpm setup` and choose again.",
      );
      return 1;
    }
    return 0;
  } catch (error) {
    const described = describeCloudError(error, "request");
    bad(described.message);
    advise("Cloud checks stopped here.", described.guidance);
    return 1;
  }
}

async function checkTrmnl(config: BridgeConfig, push: boolean): Promise<number> {
  heading("TRMNL");
  if (config.trmnl.webhookUrl === null) {
    warn("No webhook URL is stored, so the bridge has nowhere to push.");
    advise("Everything else is still configured.", "Run `pnpm setup webhook` to add it.");
    return 1;
  }
  const url = validateWebhookUrl(config.trmnl.webhookUrl);
  if (!url.ok) {
    bad(url.message);
    advise("The stored webhook URL cannot be used.", url.guidance);
    return 1;
  }
  for (const warning of url.warnings) warn(warning);
  good("The stored webhook URL has the right shape.");

  const payload = loadSyntheticPayload();
  if (payload.bytes > config.trmnl.maxPayloadBytes) {
    bad(`The synthetic payload is ${payload.bytes} bytes, above the ${config.trmnl.maxPayloadBytes}-byte ceiling.`);
    advise(
      "A real snapshot would be refused too.",
      "Raise `TRMNL_MAX_PAYLOAD_BYTES` only if the account allows it; otherwise this is a bug in the payload builder.",
    );
    return 1;
  }
  good(`Synthetic payload is ${payload.bytes} bytes, under the ${config.trmnl.maxPayloadBytes}-byte ceiling.`);

  if (!push) {
    step("Not sending anything: a push spends part of the hourly budget. Add `--push` to send one.");
    return 0;
  }

  const result = await pushPayload(url.url, payload.body);
  if (result.ok) {
    good(`TRMNL accepted a synthetic push (HTTP ${result.status}).`);
    return 0;
  }
  bad(`TRMNL refused the push (${result.kind}).`);
  advise("Nothing in the configuration was changed.", result.guidance);
  return 1;
}

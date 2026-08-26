/**
 * The interactive setup wizard.
 *
 * Written for someone who has never read this repository. Every question says
 * why it is being asked, every secret is read with a hidden prompt, and every
 * failure ends in an instruction.
 *
 * Three questions, in this order: sign in, pick printers, point at TRMNL. The
 * last one is skippable, because a new user usually has not created their
 * TRMNL Private Plugin yet and should not be blocked by it.
 */

import {
  hostsFor,
  REGIONS,
  type CloudHosts,
  type Region,
} from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/hosts";
import {
  listDevices,
  type CloudDevice,
} from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/api";
import { tokenState } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/token";
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_PUSHES_PER_HOUR,
  summarizeConfig,
  validateConfig,
  type CloudConfig,
  type TrmnlConfig,
} from "./config.ts";
import {
  describeCloudError,
  interactiveLogin,
  pasteToken,
  verifyToken,
  type CloudSession,
} from "./cloud-session.ts";
import { CANCELLED, SetupError } from "./errors.ts";
import { maskIdentifier } from "./mask.ts";
import { ask, askChoice, askValid, askYesNo } from "./prompt.ts";
import { configExists, configLabel, saveConfig } from "./store.ts";
import { loadSyntheticPayload } from "./synthetic.ts";
import { advise, bad, good, heading, say, step, warn } from "./ui.ts";
import { validateWebhookUrl } from "./webhook-url.ts";
import { pushPayload } from "./webhook-push.ts";

export async function runSetup(): Promise<void> {
  await intro();

  const cloud = await setUpCloud();
  const trmnl = await setUpTrmnl();

  const result = validateConfig({ cloud: cloud.config, trmnl, logLevel: "info" });

  if (!result.ok) {
    for (const problem of result.problems) bad(`${problem.path}: ${problem.message}`);
    throw new SetupError(
      "The answers did not add up to a valid configuration, so nothing was written.",
      result.problems[0]?.guidance ?? "Run `pnpm setup` again.",
    );
  }

  saveConfig(result.config);

  heading("Saved");
  step(`${configLabel}, mode 0600, git-ignored.`);
  say();
  for (const line of summarizeConfig(result.config)) step(line);
  say();
  step("Next steps:");
  if (result.config.trmnl.webhookUrl === null) {
    step("  pnpm setup webhook  add your TRMNL webhook URL when the plugin exists");
  }
  step("  pnpm setup doctor   re-check everything without changing it");
  step("  pnpm setup reauth   sign in again when the token expires");
  say();
}

async function intro(): Promise<void> {
  heading("trmnl-bambulab setup");
  say(
    `This writes one file, ${configLabel}, at mode 0600: a Bambu Cloud access token, which\n` +
      "printers you chose, and your TRMNL webhook URL.",
  );
  say(
    "Your Bambu account password and any verification code are used for a single request and are\n" +
      "never written to disk, never logged, and never shown on screen.",
  );
  say("This bridge only reads. It never sends a command to a printer.");

  if (configExists()) {
    say();
    warn(`${configLabel} already exists. Finishing this wizard replaces it.`);
    warn("Use `pnpm setup doctor` instead if you only want to check the current setup.");
    if (!(await askYesNo("Replace the existing configuration?", false))) throw CANCELLED;
  }
}

async function setUpCloud(): Promise<{ config: CloudConfig; devices: CloudDevice[] }> {
  heading("Bambu Cloud");
  const region = await askChoice<Region>(
    "Which Bambu Cloud region is your account in?",
    REGIONS.map((entry) => ({ label: entry.label, value: entry.id, hint: entry.api })),
  );
  const hosts = hostsFor(region);

  const path = await askChoice<"login" | "token">("How do you want to sign in?", [
    {
      label: "Sign in now",
      value: "login",
      hint: "Email and password, used once to obtain a token. Bambu then emails you a code.",
    },
    {
      label: "Paste an existing access token",
      value: "token",
      hint: "Nothing else is sent to Bambu. Use this if you already have a token.",
    },
  ]);

  const session: CloudSession = path === "token" ? await pasteToken() : await interactiveLogin(hosts);

  await verifyToken(hosts, session.accessToken, "token-check");
  good("Bambu Cloud accepted the token.");
  reportTokenState(session.accessToken);

  const devices = await selectDevices(hosts, session.accessToken);

  return {
    config: {
      region,
      accessToken: session.accessToken,
      accountHint: session.accountHint,
      deviceIds: devices.map((device) => device.id),
    },
    devices,
  };
}

function reportTokenState(accessToken: string): void {
  const state = tokenState(accessToken, Date.now());
  if (state.kind === "expiring-soon") {
    warn(
      `The token expires on ${new Date(state.expiresAt).toISOString().slice(0, 10)}. Run \`pnpm setup reauth\` when it does.`,
    );
  } else if (state.kind === "unknown-expiry") {
    warn(
      "The token carries no expiry claim, so expiry will surface the first time a request is refused.",
    );
  }
}

async function selectDevices(hosts: CloudHosts, accessToken: string): Promise<CloudDevice[]> {
  let devices: CloudDevice[];
  try {
    devices = await listDevices(hosts, accessToken);
  } catch (error) {
    throw describeCloudError(error, "request");
  }

  if (devices.length === 0) {
    throw new SetupError(
      "That Bambu account has no printers bound to it.",
      "Add the printer to your account in Bambu Handy or Bambu Studio, then run `pnpm setup` again.",
    );
  }

  if (devices.length === 1) {
    const only = devices[0] as CloudDevice;
    good(`One printer on this account: ${describeDevice(only)}.`);
    return [only];
  }

  say();
  step("Printers on this account. Identifiers are masked; only a short tail is shown.");
  say();
  devices.forEach((device, index) => {
    step(`  ${index + 1}. ${describeDevice(device)}  (id ${maskIdentifier(device.id)})`);
  });
  say();

  return await askValid("Which printers should the display follow? (numbers, or `all`)", (raw) =>
    parseSelection(raw, devices),
  );
}

/** Exported shape kept simple so the parser is testable on its own. */
export function parseSelection(
  raw: string,
  devices: CloudDevice[],
):
  | { ok: true; value: CloudDevice[] }
  | { ok: false; message: string; guidance: string } {
  const trimmed = raw.trim().toLowerCase();
  const guidance = `Enter \`all\`, or numbers between 1 and ${devices.length} separated by commas, for example \`1,3\`.`;

  if (trimmed === "") return { ok: false, message: "Nothing entered.", guidance };
  if (trimmed === "all") return { ok: true, value: [...devices] };

  const picked: CloudDevice[] = [];
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (!/^\d+$/.test(token)) {
      return { ok: false, message: `"${token}" is not a number.`, guidance };
    }
    const index = Number(token) - 1;
    const device = devices[index];
    if (device === undefined) {
      return { ok: false, message: `There is no printer ${token}.`, guidance };
    }
    if (!picked.includes(device)) picked.push(device);
  }

  if (picked.length === 0) return { ok: false, message: "No printer chosen.", guidance };
  return { ok: true, value: picked };
}

function describeDevice(device: CloudDevice): string {
  return `${device.model ?? "unknown model"} - ${device.name ?? "unnamed"} - ${describeOnline(device.online)}`;
}

function describeOnline(online: boolean | null): string {
  if (online === true) return "online";
  return online === false ? "offline" : "status unknown";
}

async function setUpTrmnl(): Promise<TrmnlConfig> {
  heading("TRMNL");
  step("Create a Private Plugin in TRMNL, choose the Webhook strategy, and copy its Webhook URL.");
  step("Treat that URL as a credential: its last path segment is the plugin-setting UUID, and");
  step("anyone holding it can write to your display. It is masked in every message printed here.");
  say();
  step("You can skip this and add it later with `pnpm setup webhook`. Everything else still saves.");
  say();

  const now = await askYesNo("Do you have the webhook URL now?", true);
  if (!now) {
    warn("Saved without a TRMNL webhook. The bridge will not push until you run `pnpm setup webhook`.");
    return {
      webhookUrl: null,
      maxPushesPerHour: DEFAULT_MAX_PUSHES_PER_HOUR,
      maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
      exportJobName: false,
    };
  }

  const webhookUrl = await askValid("TRMNL webhook URL", (raw) => {
    const result = validateWebhookUrl(raw);
    if (!result.ok) {
      return { ok: false as const, message: result.message, guidance: result.guidance };
    }
    for (const warning of result.warnings) warn(warning);
    return { ok: true as const, value: result.url };
  });

  const plus = await askYesNo("Is this a TRMNL+ account? (higher push and size ceilings)", false);
  const exportJobName = await askYesNo(
    "Show the real job name on the display? A job name can reveal a private model name.",
    false,
  );

  const trmnl: TrmnlConfig = {
    webhookUrl,
    maxPushesPerHour: plus ? 30 : DEFAULT_MAX_PUSHES_PER_HOUR,
    maxPayloadBytes: plus ? 5120 : DEFAULT_MAX_PAYLOAD_BYTES,
    exportJobName,
  };

  say();
  step("A synthetic test payload can be sent now, so you can confirm the plugin renders before any");
  step("real printer data flows. It contains no printer, account, or job information.");
  if (await askYesNo("Send the test payload?", true)) await sendTestPayload(trmnl);

  return trmnl;
}

export async function sendTestPayload(trmnl: TrmnlConfig): Promise<void> {
  if (trmnl.webhookUrl === null) {
    warn("No TRMNL webhook URL is configured, so there is nowhere to send a test payload.");
    return;
  }

  const payload = loadSyntheticPayload();
  if (payload.bytes > trmnl.maxPayloadBytes) {
    warn(
      `The test payload is ${payload.bytes} bytes and the ceiling is ${trmnl.maxPayloadBytes}, so sending it would only prove the ceiling is wrong.`,
    );
    return;
  }

  const result = await pushPayload(trmnl.webhookUrl, payload.body);
  if (result.ok) {
    good(`TRMNL accepted the payload (HTTP ${result.status}, ${payload.bytes} bytes).`);
    step("Your device shows it at its next refresh; TRMNL displays pull on a schedule.");
    return;
  }

  bad(`TRMNL refused the payload (${result.kind}, HTTP ${result.status}).`);
  advise("The configuration is still saved.", result.guidance);
}

/** Used by `pnpm setup webhook` to fill in the URL without redoing the wizard. */
export async function askWebhookUrl(): Promise<string> {
  return await askValid("TRMNL webhook URL", (raw) => {
    const result = validateWebhookUrl(raw);
    if (!result.ok) {
      return { ok: false as const, message: result.message, guidance: result.guidance };
    }
    for (const warning of result.warnings) warn(warning);
    return { ok: true as const, value: result.url };
  });
}

// `ask` stays imported for future prompts that need free text without validation.
void ask;

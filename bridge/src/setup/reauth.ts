/**
 * `pnpm setup reauth` — replace only the Bambu Cloud token.
 *
 * Token expiry is an explicit state, never a silent retry: the bridge reports
 * `reauth_required` and stops touching the cloud until this command runs. Every
 * other setting in the file, including comments and hand-made edits, is left
 * exactly as it was.
 */

import { hostsFor } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/hosts";
import { tokenState } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/token";
import { interactiveLogin, pasteToken, verifyToken, type CloudSession } from "./cloud-session.ts";
import { patchEnv } from "./config.ts";
import { SetupError } from "./errors.ts";
import { askChoice } from "./prompt.ts";
import { configLabel, loadConfig, readConfigText, writeConfigText } from "./store.ts";
import { good, heading, say, step, warn } from "./ui.ts";

const NO_CONFIG = new SetupError(
  `There is no ${configLabel} yet.`,
  "Run `pnpm setup` first; `reauth` only refreshes an existing configuration.",
);

const NO_CLOUD = new SetupError(
  "This configuration has no Bambu Cloud provider, so there is no token to refresh.",
  "Run `pnpm setup` to sign in to Bambu Cloud first.",
);

export async function runReauth(): Promise<void> {
  const text = readConfigText();
  const loaded = loadConfig();
  if (text === null || loaded === null) throw NO_CONFIG;
  if (!loaded.ok) {
    const first = loaded.problems[0];
    throw new SetupError(
      `${configLabel} is not valid, so it is not safe to patch: ${first?.message ?? "unknown problem"}`,
      first?.guidance ?? "Run `pnpm setup` to rebuild it.",
    );
  }

  const cloud = loaded.config.cloud;
  if (cloud === null) throw NO_CLOUD;

  heading("Refresh the Bambu Cloud token");
  step(`Account: ${cloud.accountHint ?? "not stored"}`);
  step(`Region:  ${cloud.region}`);

  const current = tokenState(cloud.accessToken, Date.now());
  if (current.kind === "expired") {
    step(`Current token expired on ${new Date(current.expiresAt).toISOString().slice(0, 10)}.`);
  } else if (current.kind === "valid" || current.kind === "expiring-soon") {
    step(`Current token is still valid until ${new Date(current.expiresAt).toISOString().slice(0, 10)}.`);
  } else {
    step("Current token cannot be read, so it will simply be replaced.");
  }
  say();

  const hosts = hostsFor(cloud.region);
  const choice = await askChoice<"token" | "login">("How do you want to get a new token?", [
    { label: "Paste an existing access token", value: "token" },
    {
      label: "Sign in now",
      value: "login",
      hint: "Password and any verification code are used once and never written to disk.",
    },
  ]);

  const session: CloudSession =
    choice === "token" ? await pasteToken() : await interactiveLogin(hosts);
  await verifyToken(hosts, session.accessToken, "token-check");
  good("Bambu Cloud accepted the new token.");

  // Only these two keys move. Everything else in the file stays byte-identical.
  const patched = patchEnv(text, {
    BAMBU_CLOUD_ACCESS_TOKEN: session.accessToken,
    BAMBU_CLOUD_ACCOUNT_HINT: session.accountHint ?? cloud.accountHint ?? "",
  });
  writeConfigText(patched);

  const next = tokenState(session.accessToken, Date.now());
  if (next.kind === "valid" || next.kind === "expiring-soon") {
    step(`New token expires on ${new Date(next.expiresAt).toISOString().slice(0, 10)}.`);
  } else if (next.kind === "unknown-expiry") {
    warn("The new token carries no expiry claim; expiry will surface as a refused request.");
  }

  say();
  good(`${configLabel} updated in place, mode 0600. No other setting was touched.`);
  step("Run `pnpm setup doctor` to confirm every provider.");
}

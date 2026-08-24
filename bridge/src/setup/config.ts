/**
 * The persisted bridge configuration.
 *
 * The config is written to `bridge/.env`, which is git-ignored and is also a
 * forbidden path in `scripts/secret-scan.sh`, so a credential cannot reach Git
 * through it by accident. The serialized form is therefore `KEY=VALUE` lines
 * using the keys documented in `examples/bridge.env.example`.
 *
 * This project is Bambu Cloud only and read only. There is no LAN transport, no
 * access code, and no printer configuration beyond choosing which of the
 * account's printers to show.
 *
 * Pure module: no filesystem, no network, no clock. Validation failures are
 * reported as a problem plus an instruction, never as a raw zod message, and
 * never with the offending value echoed back.
 */

import { z } from "zod";
import { looksLikeAccessToken } from "../providers/bambu-cloud/token.ts";
import type { Region } from "../providers/bambu-cloud/hosts.ts";
import { maskEmail, maskIdentifier, maskSecret, maskWebhookUrl } from "./mask.ts";
import { validateWebhookUrl } from "./webhook-url.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const REGION_IDS = ["global", "china"] as const satisfies readonly Region[];

export const DEFAULT_MAX_PUSHES_PER_HOUR = 12;
export const DEFAULT_MAX_PAYLOAD_BYTES = 2048;

export const cloudSchema = z.object({
  region: z.enum(REGION_IDS),
  accessToken: z
    .string()
    .trim()
    .min(1)
    .refine(looksLikeAccessToken, { message: "not a three-segment access token" }),
  /**
   * A masked email, never the raw one. It exists only so `reauth` can say whose
   * account it is about to refresh.
   */
  accountHint: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !(value.includes("@") && !value.includes("•")), {
      message: "account hint must be masked",
    })
    .nullable(),
  /** The printers the user chose to show. At least one. */
  deviceIds: z.array(z.string().trim().min(1)).min(1),
});

export const trmnlSchema = z.object({
  /**
   * Nullable so setup can finish before the user has created their TRMNL
   * Private Plugin. The bridge refuses to push until it is filled in, and
   * `pnpm setup webhook` fills it in without redoing the rest.
   */
  webhookUrl: z
    .string()
    .trim()
    .min(1)
    .superRefine((value, ctx) => {
      const result = validateWebhookUrl(value);
      if (!result.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message });
    })
    .nullable(),
  maxPushesPerHour: z.number().int().min(1).max(30).default(DEFAULT_MAX_PUSHES_PER_HOUR),
  maxPayloadBytes: z.number().int().min(512).max(5120).default(DEFAULT_MAX_PAYLOAD_BYTES),
  exportJobName: z.boolean().default(false),
});

export const bridgeConfigSchema = z.object({
  cloud: cloudSchema,
  trmnl: trmnlSchema,
  logLevel: z.enum(LOG_LEVELS).default("info"),
});

export type CloudConfig = z.infer<typeof cloudSchema>;
export type TrmnlConfig = z.infer<typeof trmnlSchema>;
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;

export interface ConfigProblem {
  path: string;
  message: string;
  guidance: string;
}

export type ConfigResult =
  | { ok: true; config: BridgeConfig }
  | { ok: false; problems: ConfigProblem[] };

const RERUN = "Run `pnpm setup` to reconfigure.";

/** One instruction per field. A validation failure must never dead-end. */
const GUIDANCE: Record<string, string> = {
  cloud: `Sign in to Bambu Cloud so the bridge has an account to read from. ${RERUN}`,
  "cloud.region": "Choose `global` for bambulab.com or `china` for bambulab.cn.",
  "cloud.accessToken":
    "Your Bambu Cloud token is missing or truncated. Run `pnpm setup reauth` to sign in again.",
  "cloud.accountHint":
    "Only a masked account hint may be stored. Run `pnpm setup reauth` to rewrite it.",
  "cloud.deviceIds": `Choose at least one printer from your Bambu account. ${RERUN}`,
  "trmnl.webhookUrl":
    "Open your TRMNL Private Plugin, choose the Webhook strategy, and copy its Webhook URL. Run `pnpm setup webhook` to paste it.",
  "trmnl.maxPushesPerHour":
    "A standard TRMNL account allows 12 pushes per hour and TRMNL+ allows 30. Set a whole number between 1 and 30.",
  "trmnl.maxPayloadBytes":
    "A standard TRMNL account accepts 2 kB per push and TRMNL+ accepts 5 kB. Set a whole number between 512 and 5120.",
  "trmnl.exportJobName":
    "Set `TRMNL_EXPORT_JOB_NAME` to `true` or `false`. It defaults to `false` because a job name can reveal a private model name.",
  logLevel: "Set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error`.",
};

export function validateConfig(value: unknown): ConfigResult {
  const parsed = bridgeConfigSchema.safeParse(value);
  if (parsed.success) return { ok: true, config: parsed.data };

  const problems: ConfigProblem[] = [];
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".");
    problems.push({
      path: path === "" ? "config" : path,
      message: issue.message,
      guidance: GUIDANCE[path] ?? RERUN,
    });
  }
  return { ok: false, problems };
}

/** True when the config is complete enough for the bridge to push to TRMNL. */
export function canPush(config: BridgeConfig): boolean {
  return config.trmnl.webhookUrl !== null;
}

// --- .env serialization ----------------------------------------------------

const ENV_HEADER = [
  "# trmnl-bambulab bridge configuration.",
  "#",
  "# Written by `pnpm setup`. This file holds credentials: it is git-ignored,",
  "# mode 0600, and must never be committed, pasted into an issue, or shared.",
  "# Run `pnpm setup doctor` to check it, `pnpm setup reauth` to sign in again,",
  "# `pnpm setup webhook` to set the TRMNL URL, or `pnpm setup` to start over.",
];

export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

/**
 * Rewrites only the given keys, in place, keeping every other line, comment,
 * and ordering decision in the file. `reauth` and `webhook` use this so
 * changing one thing cannot disturb the rest of a working configuration.
 */
export function patchEnv(text: string, patch: Record<string, string>): string {
  const remaining = new Map(Object.entries(patch));
  const lines = text.split("\n");
  const patched = lines.map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0 || line.trim().startsWith("#")) return line;
    const key = line.slice(0, separator).trim();
    if (!remaining.has(key)) return line;
    const value = remaining.get(key) ?? "";
    remaining.delete(key);
    return `${key}=${value}`;
  });

  // A key the file never had still has to land, or the patch silently no-ops.
  for (const [key, value] of remaining) patched.push(`${key}=${value}`);
  return patched.join("\n");
}

export function serializeEnv(config: BridgeConfig): string {
  const { cloud, trmnl } = config;
  const lines = [
    ...ENV_HEADER,
    "",
    `BAMBU_CLOUD_REGION=${cloud.region}`,
    `BAMBU_CLOUD_ACCESS_TOKEN=${cloud.accessToken}`,
    `BAMBU_CLOUD_ACCOUNT_HINT=${cloud.accountHint ?? ""}`,
    `BAMBU_CLOUD_DEVICE_IDS=${cloud.deviceIds.join(",")}`,
    "",
    `TRMNL_WEBHOOK_URL=${trmnl.webhookUrl ?? ""}`,
    `TRMNL_MAX_PUSHES_PER_HOUR=${trmnl.maxPushesPerHour}`,
    `TRMNL_MAX_PAYLOAD_BYTES=${trmnl.maxPayloadBytes}`,
    `TRMNL_EXPORT_JOB_NAME=${String(trmnl.exportJobName)}`,
    "",
    `LOG_LEVEL=${config.logLevel}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Empty is absent: an unset key and a key set to "" mean the same thing. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * `undefined` keeps a schema default. An unparseable value is passed through
 * unchanged so zod reports it against the right field instead of silently
 * falling back to a default.
 */
function booleanFrom(value: string | undefined): boolean | string | undefined {
  const raw = present(value);
  if (raw === undefined) return undefined;
  const lowered = raw.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  return raw;
}

function numberFrom(value: string | undefined): number | undefined {
  const raw = present(value);
  return raw === undefined ? undefined : Number(raw);
}

function deviceIdsFrom(value: string | undefined): string[] {
  const raw = present(value);
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function configFromEnv(env: Record<string, string | undefined>): ConfigResult {
  return validateConfig({
    cloud: {
      region: present(env.BAMBU_CLOUD_REGION) ?? "",
      accessToken: present(env.BAMBU_CLOUD_ACCESS_TOKEN) ?? "",
      accountHint: present(env.BAMBU_CLOUD_ACCOUNT_HINT) ?? null,
      deviceIds: deviceIdsFrom(env.BAMBU_CLOUD_DEVICE_IDS),
    },
    trmnl: {
      webhookUrl: present(env.TRMNL_WEBHOOK_URL) ?? null,
      maxPushesPerHour: numberFrom(env.TRMNL_MAX_PUSHES_PER_HOUR),
      maxPayloadBytes: numberFrom(env.TRMNL_MAX_PAYLOAD_BYTES),
      exportJobName: booleanFrom(env.TRMNL_EXPORT_JOB_NAME),
    },
    logLevel: present(env.LOG_LEVEL),
  });
}

/** Human-readable, fully masked. Safe to show on screen or paste into an issue. */
export function summarizeConfig(config: BridgeConfig): string[] {
  const printers = config.cloud.deviceIds.map((id) => maskIdentifier(id)).join(", ");
  return [
    `cloud region         ${config.cloud.region}`,
    `cloud account        ${config.cloud.accountHint ?? "(not stored)"}`,
    `cloud token          ${maskSecret(config.cloud.accessToken)}`,
    `printers             ${printers}`,
    `TRMNL webhook        ${
      config.trmnl.webhookUrl === null
        ? "not set yet - run `pnpm setup webhook`"
        : maskWebhookUrl(config.trmnl.webhookUrl)
    }`,
    `TRMNL push ceiling   ${config.trmnl.maxPushesPerHour} per hour`,
    `TRMNL size ceiling   ${config.trmnl.maxPayloadBytes} bytes`,
    `export job name      ${config.trmnl.exportJobName ? "yes" : "no"}`,
    `log level            ${config.logLevel}`,
  ];
}

/** Exported for `reauth`, which stores a hint without ever storing the email. */
export function accountHintFor(email: string): string {
  return maskEmail(email);
}

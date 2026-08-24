// trmnl-bambulab secret guard for Oh My Pi.
//
// Load with:  omp --hook .omp/extensions/secret-guard.ts
// or let project extension discovery pick it up.
//
// This is a warning layer, not the enforcement layer. The enforcement layer is
// .githooks/pre-commit calling scripts/secret-scan.sh, which runs no matter
// which agent or human is at the keyboard. This hook exists so a leak is
// noticed at the moment it is written rather than at commit time.
//
// @ts-nocheck

import { execFileSync } from "node:child_process";
import path from "node:path";

const FORBIDDEN_PATH = /(^|\/)(\.env($|\.)|\.dev\.vars|\.trmnlp\.yml$|captures\/|raw-telemetry\/)|\.(pcap|pcapng|pem|p12|key)$/;

const PATTERNS: Array<[string, RegExp]> = [
  ["private IPv4 address", /(^|[^0-9.])(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}/],
  ["bare UUID", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  ["JSON Web Token", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ["bearer token", /[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}/],
  ["LAN access code assignment", /(access[_-]?code|accessCode|ACCESS_CODE)["']?\s*[:=]\s*["']?[A-Za-z0-9]{6,}/],
  ["printer serial assignment", /(serial|dev_id|device_id)["']?\s*[:=]\s*["'][^"'{$][^"']{6,}/i],
  ["token or key assignment", /(access[_-]?token|refresh[_-]?token|api[_-]?key|auth[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9._~+/-]{16,}/],
  ["TRMNL webhook URL", /usetrmnl\.com\/[A-Za-z0-9_/-]*[0-9a-f-]{16,}/i],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

// Commands that would publish a control payload to the printer. v1 is
// monitoring only; see AGENTS.md.
const PRINTER_CONTROL = /mosquitto_pub|\bpublish\s*\(\s*["'`]device\/[^"'`]+\/request/;

function inspect(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const [label, pattern] of PATTERNS) {
    if (pattern.test(text)) hits.push(label);
  }
  if (PRINTER_CONTROL.test(text)) {
    hits.push("printer control command (monitoring-only boundary)");
  }
  return hits;
}

function gatherText(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    // The path itself is checked separately; hashing it into the content scan
    // produces noise on every file under a directory with a numeric name.
    if (key === "path" || key === "file_path") continue;
    parts.push(value);
  }
  return parts.join("\n");
}

function targetPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const candidate = record.path ?? record.file_path;
  return typeof candidate === "string" ? candidate : undefined;
}

export default function (pi) {
  pi.on("tool_execution_start", (event, ctx) => {
    const tool = event?.tool ?? event?.name;
    if (!["write", "edit", "bash", "python"].includes(String(tool))) return;

    const args = event?.args ?? event?.input;
    const warnings: string[] = [];

    const file = targetPath(args);
    if (file && FORBIDDEN_PATH.test(file)) {
      warnings.push(`writes to ${file}, a path that must never enter Git`);
    }

    for (const hit of inspect(gatherText(args))) {
      warnings.push(`content looks like a ${hit}`);
    }

    if (warnings.length === 0) return;

    const message = [
      "secret-guard: this call may leak a printer identifier or credential.",
      ...warnings.map((w) => `  - ${w}`),
      "Repository rule: no serial, IP, access code, cloud token, or webhook UUID in tracked files.",
      "If the value is a placeholder, mark the line with: secret-scan-allow",
    ].join("\n");

    // Surface it however the runtime allows; never throw, because a false
    // positive must not kill the session.
    try {
      ctx?.notify?.(message) ?? pi.log?.(message) ?? console.error(message);
    } catch {
      console.error(message);
    }
  });

  // Final backstop: if the agent runs a git commit, scan the staged set first.
  pi.on("tool_execution_start", (event) => {
    if (String(event?.tool ?? event?.name) !== "bash") return;
    const command = String((event?.args ?? event?.input)?.command ?? "");
    if (!/\bgit\s+commit\b/.test(command)) return;
    try {
      const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim();
      execFileSync(path.join(root, "scripts/secret-scan.sh"), ["--staged"], {
        cwd: root,
        encoding: "utf8",
      });
    } catch (error: any) {
      console.error(
        `secret-guard: staged secret scan failed before commit.\n${error?.stdout ?? error?.message ?? error}`,
      );
    }
  });
}

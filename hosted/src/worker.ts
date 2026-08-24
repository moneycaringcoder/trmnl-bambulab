/**
 * Cloudflare entrypoint for the hosted polling tier.
 *
 * The scheduled handler opens configured keys, reads due accounts from Neon and
 * delegates every account-local decision to cycle.ts. The HTTP surface is
 * deliberately inert: it exposes health, never account data or printer control.
 */

import { importKeyring } from "./crypto.ts";
import {
  networkDependencies,
  runDueAccounts,
  type AccountCycleSummary,
} from "./cycle.ts";
import { createLogger, type LogDetail } from "./log.ts";
import { NeonStore } from "./store-neon.ts";

const logger = createLogger("info");

/**
 * What a cycle contributes to the log, as a function so a test can assert
 * against the real thing.
 *
 * The safety property here is that every field is a fixed token, a byte count
 * or a hashed tag. Building the object inline in the handler made that
 * untestable: a test could only assert against its own parallel copy, which
 * would keep passing after someone added a field here. Which is precisely the
 * regression such a test exists to catch.
 *
 * The reason is included because a run is otherwise undiagnosable: "skipped"
 * alone does not say whether the display was already correct or the hourly
 * budget was spent.
 */
export function cycleLogDetail(summary: AccountCycleSummary): LogDetail {
  const result = summary.result;
  return {
    account_tag: summary.accountTag,
    outcome: result.kind,
    reason: "reason" in result ? result.reason : null,
    bytes: "bytes" in result ? result.bytes : null,
  };
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    try {
      const keySecrets: Record<string, string> = {};
      for (const [name, value] of Object.entries(env)) {
        if (
          name.startsWith("TOKEN_KEY_") &&
          name !== "TOKEN_KEY_CURRENT_ID" &&
          typeof value === "string"
        ) {
          keySecrets[name.slice("TOKEN_KEY_".length).toLowerCase()] = value;
        }
      }
      const keyring = await importKeyring(keySecrets, env.TOKEN_KEY_CURRENT_ID);
      const summaries = await runDueAccounts(
        {
          store: new NeonStore(env.DATABASE_URL),
          keyring,
          ...networkDependencies,
        },
        { now: controller.scheduledTime },
      );

      for (const summary of summaries) {
        const detail = cycleLogDetail(summary);
        const kind = summary.result.kind;
        if (kind === "failed") {
          logger.error("account cycle failed", detail);
        } else if (kind === "reauth_required" || kind === "push_refused") {
          logger.warn("account cycle needs attention", detail);
        } else {
          logger.info("account cycle completed", detail);
        }
      }
    } catch {
      // Database and configuration errors may embed credentials in their text.
      // The fixed message is useful without handing the platform that detail.
      logger.error("scheduled run failed");
    }
  },

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // Sign-in and printer-picker routes are not implemented here yet. This
    // handler must not grow an unauthenticated route that touches an account.
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;

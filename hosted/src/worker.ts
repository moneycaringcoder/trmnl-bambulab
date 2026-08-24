/**
 * Cloudflare entrypoint for the hosted tier.
 *
 * Two surfaces. The scheduled handler renders each due account's screen and
 * stores it. The fetch handler serves a stored screen to TRMNL, and answers
 * `/healthz`, and refuses everything else.
 *
 * Neither surface can reach a printer, and the fetch handler writes nothing:
 * every route here is a read. There is still no sign-in or printer-picker
 * route, and this handler must not grow an unauthenticated one that touches an
 * account.
 */

import { importKeyring } from "./crypto.ts";
import {
  networkDependencies,
  runDueAccounts,
  type AccountCycleSummary,
} from "./cycle.ts";
import { createLogger, type LogDetail } from "./log.ts";
import { serveScreen } from "./screen.ts";
import { NeonStore } from "./store-neon.ts";

const logger = createLogger("info");

/**
 * What a cycle contributes to the log, as a function so a test can assert
 * against the real thing.
 *
 * The safety property is that every field is a fixed token, a byte count, or a
 * hashed tag — nothing that names a person, a printer, or a credential.
 * Building the object inline in the handler made that untestable: a test could
 * only assert against its own parallel copy, which would keep passing after
 * someone added a field here, which is precisely the regression such a test
 * exists to catch.
 *
 * `cloud` and `bytes` are here because an outcome alone is undiagnosable:
 * "rendered" does not say whether the cloud was reachable or how big the result
 * was, and those are the two questions an operator actually has.
 */
export function cycleLogDetail(summary: AccountCycleSummary): LogDetail {
  const result = summary.result;
  return {
    account_tag: summary.accountTag,
    outcome: result.kind,
    cloud: "cloud" in result ? result.cloud : null,
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
        } else if (kind === "reauth_required" || kind === "payload_not_sendable") {
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

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/screen") {
      return await screenResponse(request, env);
    }

    // There is still no sign-in or printer-picker route. This handler must not
    // grow an unauthenticated one that touches an account.
    return notFound();
  },
} satisfies ExportedHandler<Env>;

/**
 * The response TRMNL polls.
 *
 * Every refusal is a byte-identical 404. An unknown key, a revoked key, a
 * refused address, a key for a deleted account and an account with nothing
 * rendered are one answer on purpose: a caller that can tell them apart has an
 * oracle for guessing keys.
 *
 * Nothing is logged on any path. That is not laziness about observability, it
 * is the consequence of the route being open to the internet with no rate
 * limit: if a refusal wrote a log line, an anonymous caller would control our
 * entire log volume. The scheduled handler is where this tier is observable.
 *
 * `Cache-Control: no-store` on both paths. The 200 carries one user's printer
 * state, and a 404 is heuristically cacheable, so an intermediary could
 * otherwise keep a refusal that outlives an enrolment or a key rotation.
 */
async function screenResponse(request: Request, env: Env): Promise<Response> {
  const allowed = (env.TRMNL_ALLOWED_IPS ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");

  let outcome;
  try {
    outcome = await serveScreen(
      new NeonStore(env.DATABASE_URL),
      { allowedAddresses: allowed },
      {
        // A header, never the query string: the key is a bearer credential and
        // Cloudflare's own invocation logs record the full URL of every request.
        authorization: request.headers.get("Authorization"),
        clientAddress: request.headers.get("CF-Connecting-IP"),
        now: Date.now(),
      },
    );
  } catch {
    // A database error must not become a 200 with an empty screen. Its text may
    // name a host or carry credentials, so it is neither logged nor returned.
    return new Response("Service Unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (outcome.kind !== "served") return notFound();

  return new Response(outcome.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

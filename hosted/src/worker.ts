/**
 * Cloudflare entrypoint for the hosted tier.
 *
 * Three surfaces. The scheduled handler renders each due account's screen and
 * stores it. `GET /v1/screen` serves a stored screen to TRMNL. The enrolment
 * routes under `/v1/enrol/` and `/v1/account` let a signed-in person set the
 * thing up, change it, and delete it.
 *
 * No surface here can reach a printer, and none writes to one. The screen route
 * is a pure read. The enrolment routes do write, and every one of them resolves
 * a verified session before it touches an account: this handler must never grow
 * an unauthenticated route that does.
 *
 * Only the scheduled handler logs. Both HTTP surfaces are deliberately silent,
 * for different reasons — the screen route because an anonymous caller would
 * otherwise control our log volume, and the enrolment routes because that is
 * where an email address enters the system.
 */

import { importKeyringFromEnv, openToken } from "./crypto.ts";
import { completeSignIn, discoverPrinters, requestSignInCode } from "./enrol.ts";
import {
  deleteAccount,
  getAccount,
  postKeyRotation,
  postPrinters,
  postSession,
  postSignInCode,
  type EnrolPorts,
  type RouteResult,
} from "./routes.ts";
import { SessionVerifier } from "./session.ts";
import {
  networkDependencies,
  runDueAccounts,
  type AccountCycleSummary,
} from "./cycle.ts";
import { createLogger, type LogDetail } from "./log.ts";
import { serveScreen, type ScreenOutcome } from "./screen.ts";
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

/** Named for the two call sites below; the prefix rule lives in `crypto.ts`. */
async function keyringFrom(env: Env) {
  return await importKeyringFromEnv(env as unknown as Record<string, unknown>);
}

/**
 * One verifier per isolate, so the key cache survives between requests.
 *
 * Built lazily because the configuration lives in `env`, which is not available
 * at module scope, and rebuilt if that configuration ever changes so a deploy
 * that provisions identity does not need an isolate to recycle first.
 */
let verifier: SessionVerifier | null = null;
let verifierBaseUrl: string | undefined;

function verifierFor(env: Env): SessionVerifier {
  if (verifier === null || verifierBaseUrl !== env.NEON_AUTH_BASE_URL) {
    verifierBaseUrl = env.NEON_AUTH_BASE_URL;
    verifier = new SessionVerifier({ baseUrl: env.NEON_AUTH_BASE_URL });
  }
  return verifier;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    try {
      const keyring = await keyringFrom(env);
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

    // What the setup page needs before anyone has signed in: where the identity
    // provider lives. Public by construction — the browser talks to it directly,
    // so it is not a secret and cannot be one. Nothing else is exposed here, and
    // an empty string is the honest answer on a deployment without identity.
    if (request.method === "GET" && url.pathname === "/v1/config") {
      return json({ auth_base_url: env.NEON_AUTH_BASE_URL ?? "" }, 200);
    }

    if (request.method === "GET" && url.pathname === "/v1/screen") {
      return await screenResponse(request, env);
    }

    if (url.pathname.startsWith("/v1/enrol/") || url.pathname === "/v1/account") {
      return await enrolResponse(request, env, url);
    }

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
      {
        allowedAddresses: allowed,
        addressLimiter: env.SCREEN_ADDRESS_LIMITER,
        accountLimiter: env.SCREEN_ACCOUNT_LIMITER,
      },
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

  return screenHttpResponse(outcome);
}

/**
 * The HTTP form of an outcome, as a function so a test can assert every status
 * without a database or a network.
 *
 * Every refusal that is not a rate limit is a byte-identical 404. An unknown
 * key, a malformed key, a revoked key, a key for a deleted account and an
 * account with nothing rendered are one answer on purpose: a caller that can
 * tell them apart has an oracle for guessing keys.
 */
export function screenHttpResponse(outcome: ScreenOutcome): Response {
  // Only the account ceiling answers 429, and only a caller already holding
  // that account's key can reach it, so the status reveals nothing a holder of
  // the key does not already know. The address ceiling deliberately answers the
  // same 404 as every other refusal: a 429 there would tell an enumerator that
  // its *other* attempts were the ones being rejected, which distinguishes a
  // live key from a dead one.
  if (outcome.kind === "account-limited") {
    return new Response("Too Many Requests", {
      status: 429,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        // Matches the limiter period, so a well-behaved caller waits exactly
        // long enough rather than guessing.
        "Retry-After": "60",
      },
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

/**
 * The authenticated surface, behind a verified session on every route.
 *
 * Unlike the screen endpoint, these routes are allowed to say what went wrong:
 * their caller is a signed-in person looking at a form, and a form that refuses
 * without saying why is unusable. What they never say is anything Bambu told us
 * about whether an address exists, and they never carry a cloud token.
 *
 * Nothing is logged here either, and that matters more on this surface than on
 * the last one: this is where an email address first enters the system, so a
 * single well-meaning log line would breach `AGENTS.md`.
 */
async function enrolResponse(request: Request, env: Env, url: URL): Promise<Response> {
  const verifier = verifierFor(env);
  // Identity unprovisioned means this whole surface does not exist, rather than
  // existing and trusting the caller. A deployment without an identity provider
  // must expose nothing, not everything.
  if (!verifier.configured) return notFound();

  const store = new NeonStore(env.DATABASE_URL);
  let keyring;
  try {
    keyring = await keyringFrom(env);
  } catch {
    return serviceUnavailable();
  }

  const ports: EnrolPorts = {
    store,
    keyring,
    verifier,
    limiter: env.ENROL_LIMITER,
    requestSignInCode,
    completeSignIn,
    async printersFor(account) {
      // The token is opened for exactly this call and never held.
      return await discoverPrinters(account.region, await openToken(keyring, account.id, account.token));
    },
    now: Date.now(),
  };

  const authorization = request.headers.get("Authorization");
  let body: unknown = null;
  if (request.method === "POST") {
    const raw = await request.text().catch(() => "");
    // A bodyless POST is legitimate: rotating a key takes no arguments, and
    // demanding `{}` for it would be a rule that exists only to be tripped over.
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        // A malformed body is a client mistake, and saying so beats a 500.
        return routeResponse({ kind: "invalid", guidance: "Send a JSON body." });
      }
    }
  }

  const route = `${request.method} ${url.pathname}`;
  try {
    switch (route) {
      case "POST /v1/enrol/code":
        return routeResponse(await postSignInCode(ports, authorization, body));
      case "POST /v1/enrol/session":
        return routeResponse(await postSession(ports, authorization, body));
      case "POST /v1/enrol/printers":
        return routeResponse(await postPrinters(ports, authorization, body));
      case "POST /v1/enrol/key":
        return routeResponse(await postKeyRotation(ports, authorization));
      case "GET /v1/account":
        return routeResponse(await getAccount(ports, authorization));
      case "DELETE /v1/account":
        return routeResponse(await deleteAccount(ports, authorization));
      default:
        return notFound();
    }
  } catch {
    // A database or crypto failure. Its text can name a host or carry key
    // material, so it is neither logged nor returned.
    return serviceUnavailable();
  }
}

/**
 * The HTTP form of a route decision, in one place so no route invents its own.
 *
 * `unauthenticated` is a 401 rather than the screen endpoint's 404. The
 * reasoning differs because the threat differs: there, an honest status would
 * have told a key-guesser whether a key existed, whereas here the caller is a
 * person with a browser who needs to be told to sign in again.
 */
export function routeResponse(result: RouteResult): Response {
  switch (result.kind) {
    case "done":
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    case "printers":
      return json({ printers: result.printers }, 200);
    case "key-issued":
      // The one response in this Worker that carries a screen key. It is shown
      // once and never stored, so a caller that loses it must rotate.
      return json({ screen_key: result.screenKey }, 200);
    case "account":
      return json({ device_ids: result.deviceIds, reauth_required: result.reauthRequired }, 200);
    case "unauthenticated":
      return json({ error: "Sign in again." }, 401);
    case "no-account":
      // Reached by the picker, the key rotation and the delete, so the wording
      // has to fit all three. The previous text said no printer was set up,
      // which read as a contradiction to someone in the middle of setting one
      // up after their session had lapsed.
      return json(
        { error: "Nothing is connected to this account yet. Connect Bambu Cloud first." },
        404,
      );
    case "throttled":
      return new Response(JSON.stringify({ error: "Too many attempts. Wait a minute." }), {
        status: 429,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "60",
        },
      });
    case "invalid":
      return json({ error: result.guidance }, 400);
    case "upstream":
      // A refused code is the caller's mistake and a 400 says so; only a genuine
      // Bambu failure is a 502. Reporting both as 502 told someone who mistyped
      // a code that the service was down, which is advice to wait when the right
      // advice is to look at their inbox again.
      return json(
        { error: result.failure.guidance },
        result.failure.kind === "cloud-unavailable" ? 502 : 400,
      );
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function serviceUnavailable(): Response {
  return new Response("Service Unavailable", {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Cloudflare entrypoint for the hosted tier.
 *
 * Three surfaces. The scheduled handler renders each due account's screen and
 * stores it. The `/trmnl/` routes speak TRMNL's third-party plugin protocol:
 * install, success webhook, markup, uninstall. The enrolment routes under
 * `/v1/enrol/` and `/v1/account` let the person who installed the plugin sign
 * in to Bambu, pick printers, and delete everything.
 *
 * Identity is TRMNL's. The install handshake exchanges a single-use code for a
 * per-installation access token; TRMNL presents that token on every request it
 * makes, and the setup page holds a short-lived management token signed with
 * our own keyring. There is no other account system.
 *
 * No surface here can reach a printer, and none writes to one. Every enrolment
 * route resolves an installation before it touches an account: this handler
 * must never grow an unauthenticated route that writes.
 *
 * Only the scheduled handler logs. The HTTP surfaces are deliberately silent —
 * the TRMNL routes because an anonymous caller would otherwise control our log
 * volume, and the enrolment routes because that is where an email address
 * enters the system.
 */

import { importKeyringFromEnv, openToken, type Keyring } from "./crypto.ts";
import { completeSignIn, discoverPrinters, requestSignInCode } from "./enrol.ts";
import {
  deleteAccount,
  getAccount,
  postPrinters,
  postSession,
  postSignInCode,
  type EnrolPorts,
  type RouteResult,
} from "./routes.ts";
import {
  install,
  manage,
  markup,
  recordInstallSuccess,
  uninstall,
  type TrmnlPorts,
} from "./trmnl.ts";
import {
  networkDependencies,
  runDueAccounts,
  type AccountCycleSummary,
} from "./cycle.ts";
import { createLogger, type LogDetail } from "./log.ts";
import { NeonStore } from "./store-neon.ts";

/** Enough for three selections or TRMNL's webhook, small enough to bound abuse. */
const JSON_BODY_LIMIT_BYTES = 8 * 1024;

type JsonBody =
  | { kind: "ok"; value: unknown }
  | { kind: "malformed" }
  | { kind: "too-large" };

/**
 * Reads a small JSON body without trusting Content-Length.
 *
 * The header is only an early refusal. The stream count remains authoritative,
 * so an absent, malformed, or deliberately understated header cannot turn
 * `request.text()` into an unbounded allocation.
 */
async function readJsonBody(request: Request): Promise<JsonBody> {
  const statedLength = request.headers.get("Content-Length");
  if (
    statedLength !== null &&
    /^\d+$/.test(statedLength) &&
    Number(statedLength) > JSON_BODY_LIMIT_BYTES
  ) {
    return { kind: "too-large" };
  }

  if (request.body === null) return { kind: "ok", value: null };

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let raw = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value === undefined) continue;
      if (chunk.value.byteLength > JSON_BODY_LIMIT_BYTES - bytes) {
        try {
          await reader.cancel();
        } catch {
          // The size decision is already final; cancellation failure is not
          // information the anonymous caller should observe.
        }
        return { kind: "too-large" };
      }
      bytes += chunk.value.byteLength;
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  } catch {
    return { kind: "malformed" };
  } finally {
    reader.releaseLock();
  }

  if (raw.trim() === "") return { kind: "ok", value: null };
  try {
    return { kind: "ok", value: JSON.parse(raw) as unknown };
  } catch {
    return { kind: "malformed" };
  }
}

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
 * was, and those are the two questions a log reader actually has.
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

/** Where a single-use install code is exchanged. TRMNL's, fixed, never ours. */
const TRMNL_TOKEN_URL = "https://trmnl.com/oauth/token";

/**
 * Exchanges an install code at TRMNL's token endpoint.
 *
 * TRMNL answers HTTP 200 for both outcomes and distinguishes them in the body,
 * so this maps `{ error: true }` to a refusal rather than trusting the status
 * line. The token never reaches a log and is immediately reduced to a tag.
 */
async function exchangeCodeAtTrmnl(
  code: string,
): Promise<{ ok: true; accessToken: string } | { ok: false }> {
  let response: Response;
  try {
    response = await fetch(TRMNL_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code }),
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false };
  }
  if (typeof body !== "object" || body === null) return { ok: false };
  if ("error" in body && body.error) return { ok: false };
  const token = "access_token" in body ? body.access_token : null;
  if (typeof token !== "string" || token === "") return { ok: false };
  return { ok: true, accessToken: token };
}

function trmnlPortsFrom(store: NeonStore, keyring: Keyring): TrmnlPorts {
  return {
    store,
    keyring,
    exchangeCode: exchangeCodeAtTrmnl,
    now: () => Date.now(),
  };
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

    if (url.pathname.startsWith("/trmnl/")) {
      return await trmnlResponse(request, env, url);
    }

    if (url.pathname.startsWith("/v1/enrol/") || url.pathname === "/v1/account") {
      return await enrolResponse(request, env, url);
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;

/**
 * TRMNL's own surface: install redirect, success webhook, markup, uninstall.
 *
 * Every request is metered by address before it can reach the database,
 * because three of the four routes accept anonymous callers up to the moment a
 * token is verified. A refusal is a plain status with no body detail: the
 * caller is TRMNL's server or an abuser, and neither needs prose.
 *
 * Nothing is logged on any path, for the same reason the polling endpoint
 * never logged: an anonymous caller must not control our log volume.
 */
async function trmnlResponse(request: Request, env: Env, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  const limited = await screenAddressLimitResponse(
    request,
    env,
    route === "GET /trmnl/install",
  );
  if (limited !== null) return limited;
  let installedBody: unknown = null;
  if (route === "POST /trmnl/installed") {
    const parsed = await readJsonBody(request);
    if (parsed.kind === "too-large") return payloadTooLarge();
    if (parsed.kind === "ok") installedBody = parsed.value;
  }

  const store = new NeonStore(env.DATABASE_URL);
  let keyring: Keyring;
  try {
    keyring = await keyringFrom(env);
  } catch {
    return serviceUnavailable();
  }
  const ports = trmnlPortsFrom(store, keyring);

  try {
    // The install redirect: TRMNL sends the user's browser here with a
    // single-use code. Exchange it, then hand the browser to the setup page
    // with a short-lived management token in the fragment — the fragment,
    // not the query, so it never appears in request logs anywhere.
    if (route === "GET /trmnl/install") {
      const code = url.searchParams.get("code") ?? "";
      const callback = url.searchParams.get("installation_callback_url") ?? "";
      const outcome = await install(ports, code);
      if (outcome.kind === "refused") {
        return new Response("The installation link has expired. Install the plugin again.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      const destination = new URL("/", url.origin);
      // The callback is how the user gets back to TRMNL when they finish.
      // Refused unless it points at TRMNL, so this cannot redirect through us
      // to anywhere an attacker chose.
      const back = safeTrmnlCallback(callback);
      destination.hash = back === null
        ? `manage=${outcome.manageToken}`
        : `manage=${outcome.manageToken}&back=${encodeURIComponent(back)}`;
      return Response.redirect(destination.toString(), 302);
    }

    // TRMNL's Configure button: it redirects the user's browser here with the
    // uuid the success webhook recorded. Convert it into a fragment token the
    // same way the install redirect does; an unknown uuid lands on the page's
    // open-from-TRMNL panel rather than an error.
    if (route === "GET /trmnl/manage") {
      const outcome = await manage(ports, url.searchParams.get("uuid") ?? "");
      const destination = new URL("/", url.origin);
      if (outcome.kind === "redirect") {
        destination.hash =
          outcome.backUrl === null
            ? `manage=${outcome.manageToken}`
            : `manage=${outcome.manageToken}&back=${encodeURIComponent(outcome.backUrl)}`;
      }
      return Response.redirect(destination.toString(), 302);
    }

    if (route === "POST /trmnl/installed") {
      const result = await recordInstallSuccess(
        ports,
        request.headers.get("Authorization"),
        installedBody,
      );
      if (result === "unauthenticated") return unauthorized();
      if (result === "invalid") return json({ error: "Send TRMNL's webhook body." }, 400);
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }

    if (route === "POST /trmnl/markup") {
      const outcome = await markup(ports, request.headers.get("Authorization"));
      if (outcome.kind === "unauthenticated") return unauthorized();
      return json(outcome.markup, 200);
    }

    if (route === "POST /trmnl/uninstall") {
      const result = await uninstall(ports, request.headers.get("Authorization"));
      if (result === "unauthenticated") return unauthorized();
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }

    return notFound();
  } catch {
    // A database or crypto failure. Its text can name a host or carry key
    // material, so it is neither logged nor returned.
    return serviceUnavailable();
  }
}

/**
 * Accepts a callback only if it is TRMNL's own HTTPS origin.
 *
 * The install redirect would otherwise be an open redirector: the callback
 * arrives in *our* query string, so anyone could craft an install link whose
 * "back to TRMNL" button leads somewhere hostile.
 */
export function safeTrmnlCallback(callback: string): string | null {
  if (callback === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(callback);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "trmnl.com" && !parsed.hostname.endsWith(".trmnl.com")) return null;
  return parsed.toString();
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
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
 * The authenticated surface, behind a verified management token on every route.
 *
 * Unlike the TRMNL surface, these routes are allowed to say what went wrong:
 * their caller is a person looking at a form, and a form that refuses without
 * saying why is unusable. What they never say is anything Bambu told us about
 * whether an address exists, and they never carry a cloud token.
 *
 * Nothing is logged here either, and that matters more on this surface than on
 * the last one: this is where an email address first enters the system, so a
 * single well-meaning log line would breach `AGENTS.md`.
 */
async function enrolResponse(request: Request, env: Env, url: URL): Promise<Response> {
  const limited = await screenAddressLimitResponse(request, env);
  if (limited !== null) return limited;

  const route = `${request.method} ${url.pathname}`;
  let body: unknown = null;
  if (request.method === "POST") {
    const parsed = await readJsonBody(request);
    if (parsed.kind === "too-large") return payloadTooLarge();
    if (parsed.kind === "malformed") {
      return routeResponse({ kind: "invalid", guidance: "Send a JSON body." });
    }
    body = parsed.value;
  }

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
  try {
    switch (route) {
      case "POST /v1/enrol/code":
        return routeResponse(await postSignInCode(ports, authorization, body));
      case "POST /v1/enrol/session":
        return routeResponse(await postSession(ports, authorization, body));
      case "POST /v1/enrol/printers":
        return routeResponse(await postPrinters(ports, authorization, body));
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

/**
 * The anonymous address ceiling is a cost guard, not authentication. Verified
 * traffic defaults fail-open for availability; callers that perform anonymous
 * outbound work request fail-closed behavior. ENROL_LIMITER remains fail-closed
 * inside the Bambu email/code operations.
 */
async function screenAddressLimitResponse(
  request: Request,
  env: Env,
  failClosed = false,
): Promise<Response | null> {
  try {
    const permitted = await env.SCREEN_ADDRESS_LIMITER.limit({
      key: request.headers.get("CF-Connecting-IP") ?? "unknown",
    });
    if (!permitted.success) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      });
    }
  } catch {
    // The install redirect performs an unauthenticated outbound token exchange,
    // so a missing limiter must close that path. Other routes retain fail-open
    // availability; their token checks and Bambu-operation limiter still hold.
    if (failClosed) return serviceUnavailable();
  }
  return null;
}

function payloadTooLarge(): Response {
  return new Response("Payload Too Large", {
    status: 413,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
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

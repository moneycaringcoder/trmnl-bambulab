/**
 * The screen endpoint: what TRMNL fetches.
 *
 * `GET /v1/screen` with `Authorization: Bearer <screen key>` returns one
 * account's rendered payload, merge variables at the root, which is the shape
 * TRMNL's polling strategy reads. Nothing else is exposed and nothing is
 * written.
 *
 * **The key is a header, never a query parameter.** It is a bearer credential,
 * and a credential in a URL is written down by everything the request passes
 * through: Cloudflare's own invocation logs record `<Method> <URL>` for every
 * request, and every intermediary keeps an access log. TRMNL's polling strategy
 * supports interpolating a form field into a header — its own documentation
 * shows `authorization=bearer ##{{ api_key }}` — so there is no reason to
 * accept the leak.
 *
 * It serves a *stored* render rather than reading Bambu. The cron does the
 * reading on its own five-minute schedule. That separation is the whole point
 * of the polling design: TRMNL fetches on a schedule the user chooses, so an
 * endpoint that read Bambu on demand would let one user's refresh setting
 * decide how hard we hit Bambu, would put two cloud round-trips inside TRMNL's
 * request timeout, and would let anyone holding a key generate load on Bambu at
 * will. Here, Bambu's load is a function of our cron and nothing else.
 *
 * No Cloudflare types and no `env`: everything arrives as an argument so this
 * is testable without a Worker.
 */

import { screenKeyFingerprint } from "./crypto.ts";
import type { Screen, Store } from "./store.ts";

/**
 * How old a render may be before the endpoint stops calling it fresh.
 *
 * Three missed cron cycles. The screen is still served — a display showing the
 * last known truth beats a blank one — but the body says how old it is so the
 * template can admit it rather than presenting it as current.
 */
export const FRESH_FOR_MS = 15 * 60_000;

export interface ScreenRequest {
  /**
   * The raw `Authorization` header, or null when there was none. Parsed here
   * rather than by the caller so the one place a key is extracted is the one
   * place it is tested.
   */
  authorization: string | null;
  /** The client address, for the optional allowlist. Null when unknown. */
  clientAddress: string | null;
  now: number;
}

/**
 * Pulls the key out of an `Authorization: Bearer <key>` header.
 *
 * The scheme match is case-insensitive because HTTP says it is, and a client
 * sending `bearer` in lower case is not wrong. Anything else — a bare value, a
 * different scheme, an empty token — yields null and is refused, rather than
 * being guessed at.
 */
function bearerToken(authorization: string | null): string | null {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
}

export interface ScreenPolicy {
  /**
   * TRMNL's own server addresses, from `https://trmnl.com/api/ips`. Empty means
   * unrestricted, which is a deliberate default rather than an oversight: the
   * key is the authentication, the allowlist is depth, and shipping with a
   * guessed address list would lock TRMNL out of every account at once.
   */
  allowedAddresses: readonly string[];
}

/**
 * Freshness the endpoint adds to the stored body at serve time.
 *
 * It has to be added here rather than baked in by the cron, because the whole
 * failure this guards against is the cron having stopped. A body that carried
 * its own "I am fresh" would keep claiming it forever.
 *
 * `fresh` reads positively so it cannot be confused with the per-printer
 * `stale`, which is a different claim: that one is about a printer we have not
 * heard from, this one is about a render nobody has refreshed.
 */
export interface Freshness {
  age_minutes: number;
  fresh: boolean;
}

export type ScreenOutcome =
  | { kind: "served"; body: string; freshness: Freshness }
  | { kind: "no-key" }
  | { kind: "unknown-key" }
  | { kind: "not-rendered-yet" }
  | { kind: "unreadable-render" }
  | { kind: "address-refused" };

/**
 * Resolves a request to an outcome.
 *
 * An unknown key, a revoked key and a key belonging to a deleted account all
 * come back as `unknown-key`. They are indistinguishable on purpose: telling a
 * caller which of those it hit turns the endpoint into an oracle for guessing
 * keys, and none of the three has a different remedy.
 *
 * An account whose token the cloud has refused still gets its screen. Its owner
 * needs to re-authenticate, and they are far more likely to notice a display
 * saying the reading is hours old than one that has simply gone blank.
 */
export async function serveScreen(
  store: Store,
  policy: ScreenPolicy,
  request: ScreenRequest,
): Promise<ScreenOutcome> {
  if (policy.allowedAddresses.length > 0) {
    // A missing address while an allowlist is configured is a refusal, not a
    // pass. An allowlist that stops applying when the platform omits a header
    // is not an allowlist.
    if (request.clientAddress === null) return { kind: "address-refused" };
    if (!policy.allowedAddresses.includes(request.clientAddress)) {
      return { kind: "address-refused" };
    }
  }

  const key = bearerToken(request.authorization);
  if (key === null) return { kind: "no-key" };

  const account = await store.accountByScreenKey(await screenKeyFingerprint(key));
  if (account === null) return { kind: "unknown-key" };

  const screen: Screen | null = await store.readScreen(account.id);
  if (screen === null) return { kind: "not-rendered-yet" };

  const ageMs = Math.max(0, request.now - screen.renderedAt);
  const freshness: Freshness = {
    age_minutes: Math.floor(ageMs / 60_000),
    fresh: ageMs <= FRESH_FOR_MS,
  };

  // Parsed and re-serialized rather than spliced, because merge variables have
  // to sit at the root of the response and there is nowhere to wrap them. The
  // body is a few hundred bytes, so the cost is not worth being clever about.
  let rendered: unknown;
  try {
    rendered = JSON.parse(screen.body);
  } catch {
    // A body we cannot read is not a body. Better to say nothing was rendered
    // than to hand TRMNL something malformed and have it draw a broken screen.
    return { kind: "unreadable-render" };
  }
  if (typeof rendered !== "object" || rendered === null || Array.isArray(rendered)) {
    return { kind: "unreadable-render" };
  }

  return {
    kind: "served",
    body: JSON.stringify({ ...(rendered as Record<string, unknown>), ...freshness }),
    freshness,
  };
}

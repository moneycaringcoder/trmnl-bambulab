/**
 * One POST to the TRMNL webhook.
 *
 * Used by setup to send a synthetic payload, and by `doctor` to confirm the
 * plugin still accepts a push. It sends exactly one request: TRMNL's hourly
 * ceiling is low, and a setup command must never spend a user's push budget on
 * retries.
 *
 * The URL is a credential. It is never logged, and no failure message contains
 * it.
 */

export type PushFailure =
  | "rate-limited"
  | "too-large"
  | "unauthorized"
  | "not-found"
  | "server-error"
  | "client-error"
  | "network-error"
  | "timeout";

export type PushResult =
  | { ok: true; status: number }
  | { ok: false; kind: PushFailure; status: number; guidance: string };

const GUIDANCE: Record<PushFailure, string> = {
  "rate-limited":
    "TRMNL answered 429: too many pushes this hour. A standard account allows 12 per hour and TRMNL+ allows 30. Wait for the hour to roll over, then try again; the bridge itself stays under the ceiling by design.",
  "too-large":
    "TRMNL rejected the payload as too large. A standard account accepts 2 kB per push. Lower `TRMNL_MAX_PAYLOAD_BYTES`, or upgrade the account if you need 5 kB.",
  unauthorized:
    "TRMNL rejected the webhook URL. Open the plugin, copy the Webhook URL again, and run `pnpm setup` to paste the current one.",
  "not-found":
    "TRMNL does not recognize that webhook URL. The plugin may have been deleted or recreated, which changes the UUID. Copy the current Webhook URL from the plugin and run `pnpm setup` again.",
  "server-error":
    "TRMNL had a server error. Nothing is wrong with your configuration; try again in a few minutes.",
  "client-error":
    "TRMNL refused the request. Confirm the plugin uses the Webhook strategy, then copy its Webhook URL again.",
  "network-error":
    "This machine could not reach TRMNL. Check its internet connection and any outbound proxy or firewall rule.",
  timeout:
    "TRMNL did not answer in time. Check this machine's internet connection, then try again.",
};

function classify(status: number): PushFailure {
  if (status === 429) return "rate-limited";
  if (status === 413) return "too-large";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  if (status >= 500) return "server-error";
  return "client-error";
}

export async function pushPayload(
  url: string,
  body: unknown,
  timeoutMs = 15_000,
): Promise<PushResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
  } catch {
    const kind: PushFailure = controller.signal.aborted ? "timeout" : "network-error";
    return { ok: false, kind, status: 0, guidance: GUIDANCE[kind] };
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) return { ok: true, status: response.status };
  const kind = classify(response.status);
  return { ok: false, kind, status: response.status, guidance: GUIDANCE[kind] };
}

/**
 * Bambu Cloud HTTP transport.
 *
 * Reverse-engineered from OpenBambuAPI and ha-bambulab. Not a supported public
 * API contract; expect drift.
 *
 * Rules this module obeys:
 *  - TLS defaults are never touched. There is no verification bypass.
 *  - An error never carries the response body, a token, an email, or a device
 *    identifier. Bodies from this service can contain account detail.
 *  - Nothing here retries. Retry policy belongs to the caller, and a failed
 *    login must never be retried automatically.
 */

import type { CloudHosts } from "./hosts.ts";

export type CloudErrorCategory =
  | "unauthorized-or-expired"
  | "blocked-by-cloudflare"
  | "rate-limited"
  | "server-error"
  | "client-error"
  | "network-error"
  | "timeout";

export class CloudError extends Error {
  // Plain fields, not parameter properties: the bridge runs from source under
  // Node's type stripping, which cannot rewrite a parameter property.
  status: number;
  category: CloudErrorCategory;

  /** `status` is 0 when the request never produced an HTTP response. */
  constructor(status: number, category: CloudErrorCategory) {
    super(
      status === 0
        ? `bambu cloud request failed: ${category}`
        : `bambu cloud request failed: HTTP ${status} (${category})`,
    );
    this.name = "CloudError";
    this.status = status;
    this.category = category;
  }
}

export function categorize(status: number, body: string): CloudErrorCategory {
  if (status === 401 || status === 403) {
    // A Cloudflare challenge and an expired token both arrive as 401/403 and
    // need opposite advice, so they must not collapse into one category.
    if (/cloudflare/i.test(body)) return "blocked-by-cloudflare";
    return "unauthorized-or-expired";
  }
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server-error";
  return "client-error";
}

/**
 * The cloud rejects generic clients. These are the headers the community
 * clients send; they are a compatibility shim, not an attempt to hide.
 */
export function baseHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "bambu_network_agent/01.09.05.01",
    "X-BBL-Client-Name": "OrcaSlicer",
    "X-BBL-Client-Type": "slicer",
    "X-BBL-Client-Version": "01.09.05.51",
    "X-BBL-Language": "en-US",
    "X-BBL-OS-Type": "linux",
    "X-BBL-OS-Version": "6.2.0",
    "X-BBL-Agent-Version": "01.09.05.01",
    "X-BBL-Agent-OS-Type": "linux",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

export async function request<T>(
  hosts: CloudHosts,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", token, body, timeoutMs = 15_000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const init: RequestInit = {
    method,
    headers: baseHeaders(token),
    signal: controller.signal,
    // A redirect could carry credentials to another host. Refuse to follow.
    redirect: "manual",
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(`${hosts.api}${path}`, init);
  } catch {
    // The cause can name the host and the request detail; the category is all
    // the caller is allowed to see.
    throw new CloudError(0, controller.signal.aborted ? "timeout" : "network-error");
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new CloudError(response.status, categorize(response.status, text));
  }
  return (text ? (JSON.parse(text) as T) : ({} as T));
}

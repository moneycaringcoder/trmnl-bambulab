import { describe, expect, it } from "vitest";
import { cycleLogDetail, routeResponse, screenHttpResponse } from "../src/worker.ts";
import type { ScreenOutcome } from "../src/screen.ts";
import type { RouteResult } from "../src/routes.ts";
import type { AccountCycleSummary } from "../src/cycle.ts";

const TAG = "0123456789abcdef";

/**
 * The guard that matters here is not that today's four fields are safe — they
 * plainly are. It is that adding a fifth fails the suite. `worker.ts` is the
 * module carrying the never-log-a-credential obligation, and a summary object is
 * exactly the kind of thing someone enriches with "just the account id, for
 * debugging" six months from now.
 */
describe("cycleLogDetail", () => {
  const summaries: AccountCycleSummary[] = [
    { accountTag: TAG, result: { kind: "rendered", cloud: "connected", bytes: 306 } },
    { accountTag: TAG, result: { kind: "reauth_required" } },
    {
      accountTag: TAG,
      result: { kind: "payload_not_sendable", cloud: "connected", bytes: 9001 },
    },
    { accountTag: TAG, result: { kind: "failed" } },
  ];

  it("emits exactly four fields, whatever the outcome", () => {
    for (const summary of summaries) {
      expect(Object.keys(cycleLogDetail(summary)).sort()).toEqual([
        "account_tag",
        "bytes",
        "cloud",
        "outcome",
      ]);
    }
  });

  it("emits only scalars and nulls, so no object can be smuggled into a log", () => {
    for (const summary of summaries) {
      for (const value of Object.values(cycleLogDetail(summary))) {
        if (value === null) continue;
        expect(["string", "number", "boolean"]).toContain(typeof value);
      }
    }
  });

  it("carries the hashed tag rather than anything identifying", () => {
    const detail = cycleLogDetail(summaries[0] as AccountCycleSummary);
    expect(detail.account_tag).toBe(TAG);
    expect(detail.account_tag).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reports the reason through the outcome, and the size when there is one", () => {
    expect(cycleLogDetail(summaries[0] as AccountCycleSummary)).toEqual({
      account_tag: TAG,
      outcome: "rendered",
      cloud: "connected",
      bytes: 306,
    });
    // An outcome with nothing to measure says so rather than inventing a zero.
    expect(cycleLogDetail(summaries[1] as AccountCycleSummary)).toEqual({
      account_tag: TAG,
      outcome: "reauth_required",
      cloud: null,
      bytes: null,
    });
  });
});

describe("screenHttpResponse", () => {
  // The oracle property, as a test. If any of these ever differ from each other
  // a caller can tell a real key from a wrong one, which is the whole thing the
  // 404 exists to prevent.
  it("answers every refusal an anonymous caller can reach with one 404", async () => {
    const refusals: ScreenOutcome[] = [
      { kind: "no-key" },
      { kind: "unknown-key" },
      { kind: "not-rendered-yet" },
      { kind: "unreadable-render" },
      { kind: "address-refused" },
      // The address ceiling belongs in this set. A 429 here would tell an
      // enumerator that its other attempts were the rejected ones, which
      // distinguishes a live key from a dead one.
      { kind: "address-limited" },
    ];

    const shapes = new Set<string>();
    for (const outcome of refusals) {
      const response = screenHttpResponse(outcome);
      const headers: string[] = [];
      response.headers.forEach((value, name) => headers.push(`${name}: ${value}`));
      shapes.add(JSON.stringify([response.status, headers.sort(), await response.text()]));
    }

    expect(shapes.size).toBe(1);
    expect(screenHttpResponse({ kind: "unknown-key" }).status).toBe(404);
  });

  // Safe to distinguish, because reaching this counter requires already holding
  // the account's key.
  it("answers the account ceiling with 429 and how long to wait", async () => {
    const response = screenHttpResponse({ kind: "account-limited" });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never lets a refusal be cached as an answer", () => {
    for (const kind of ["unknown-key", "address-limited", "account-limited"] as const) {
      expect(screenHttpResponse({ kind }).headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("serves the stored body unchanged, and does not cache it either", async () => {
    const body = JSON.stringify({ merge_variables: { printers: [] } });
    const response = screenHttpResponse({
      kind: "served",
      body,
      freshness: { age_minutes: 3, fresh: true },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    // Per-device refresh, per account, forever: caching one render would freeze
    // every display sharing an edge.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("routeResponse", () => {
  // The page reads status codes to decide what to show, so each one is part of
  // the contract between the two halves rather than an implementation detail.
  it("maps every route decision to the status the page expects", async () => {
    const cases: [RouteResult, number][] = [
      [{ kind: "done" }, 204],
      [{ kind: "printers", printers: [] }, 200],
      [{ kind: "key-issued", screenKey: "k" }, 200],
      [{ kind: "account", deviceIds: [], reauthRequired: false }, 200],
      [{ kind: "unauthenticated" }, 401],
      [{ kind: "no-account" }, 404],
      [{ kind: "throttled" }, 429],
      [{ kind: "invalid", guidance: "g" }, 400],
      [{ kind: "upstream", failure: { kind: "refused", guidance: "g" } }, 400],
      [{ kind: "upstream", failure: { kind: "cloud-unavailable", guidance: "g" } }, 502],
      [{ kind: "upstream", failure: { kind: "no-printers", guidance: "g" } }, 400],
    ];

    for (const [result, status] of cases) {
      expect(routeResponse(result).status, JSON.stringify(result)).toBe(status);
    }
  });

  it("never caches an authenticated answer", () => {
    const results: RouteResult[] = [
      { kind: "done" },
      { kind: "key-issued", screenKey: "k" },
      { kind: "account", deviceIds: [], reauthRequired: false },
      { kind: "unauthenticated" },
      { kind: "throttled" },
    ];
    for (const result of results) {
      expect(routeResponse(result).headers.get("Cache-Control")).toBe("no-store");
    }
  });

  // The one response that carries a key, and the only one.
  it("carries a screen key in exactly one response shape", async () => {
    const issued = await routeResponse({ kind: "key-issued", screenKey: "secret-key-value" }).text();
    expect(JSON.parse(issued)).toEqual({ screen_key: "secret-key-value" });
    const quiet: RouteResult[] = [
      { kind: "done" },
      { kind: "account", deviceIds: ["d"], reauthRequired: false },
      { kind: "printers", printers: [] },
    ];
    for (const result of quiet) {
      expect(await routeResponse(result).text()).not.toContain("secret-key-value");
    }
  });
});

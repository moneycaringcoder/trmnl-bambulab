import { describe, expect, it } from "vitest";
import { cycleLogDetail, routeResponse, safeTrmnlCallback } from "../src/worker.ts";
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

describe("safeTrmnlCallback", () => {
  // The install redirect forwards the user "back to TRMNL" at a URL that
  // arrived in our own query string. Without this check that is an open
  // redirector: anyone could craft an install link whose final hop lands
  // somewhere hostile that looks like TRMNL.
  it("accepts TRMNL's own https origins", () => {
    expect(safeTrmnlCallback("https://trmnl.com/plugin_settings/new?code=x")).toContain(
      "trmnl.com",
    );
    expect(safeTrmnlCallback("https://usetrmnl.trmnl.com/x")).toContain(".trmnl.com");
  });

  it("refuses everything else", () => {
    for (const hostile of [
      "https://evil.example/phish",
      "http://trmnl.com/downgraded",
      "https://nottrmnl.com/x",
      "https://trmnl.com.evil.example/x",
      "javascript:alert(1)",
      "not a url",
      "",
    ]) {
      expect(safeTrmnlCallback(hostile), hostile).toBeNull();
    }
  });
});

describe("routeResponse", () => {
  // The page reads status codes to decide what to show, so each one is part of
  // the contract between the two halves rather than an implementation detail.
  it("maps every route decision to the status the page expects", async () => {
    const cases: [RouteResult, number][] = [
      [{ kind: "done" }, 204],
      [{ kind: "printers", printers: [] }, 200],
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
      { kind: "account", deviceIds: [], reauthRequired: false },
      { kind: "unauthenticated" },
      { kind: "throttled" },
    ];
    for (const result of results) {
      expect(routeResponse(result).headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

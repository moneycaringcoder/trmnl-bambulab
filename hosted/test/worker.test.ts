import { describe, expect, it } from "vitest";
import { cycleLogDetail } from "../src/worker.ts";
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

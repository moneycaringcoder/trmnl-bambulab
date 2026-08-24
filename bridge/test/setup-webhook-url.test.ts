import { describe, expect, it } from "vitest";
import { validateWebhookUrl } from "../src/setup/webhook-url.ts";
import { syntheticUuid, syntheticWebhookUrl } from "./synthetic-values.ts";

function reject(raw: string): { message: string; guidance: string } {
  const result = validateWebhookUrl(raw);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.guidance.length).toBeGreaterThan(0);
  return { message: result.message, guidance: result.guidance };
}

describe("validateWebhookUrl", () => {
  it("accepts a well-formed TRMNL webhook URL", () => {
    const result = validateWebhookUrl(syntheticWebhookUrl());
    expect(result).toEqual({ ok: true, url: syntheticWebhookUrl(), warnings: [] });
  });

  it("trims whitespace and a trailing slash", () => {
    const result = validateWebhookUrl(`  ${syntheticWebhookUrl()}/  `);
    expect(result.ok && result.url).toBe(syntheticWebhookUrl());
  });

  it("accepts a 32-character hex identifier", () => {
    const url = `https://usetrmnl.com/api/custom_plugins/${"a".repeat(32)}`;
    expect(validateWebhookUrl(url).ok).toBe(true);
  });

  it("refuses plain http, because the URL is a credential", () => {
    const { guidance } = reject(`http://usetrmnl.com/api/custom_plugins/${syntheticUuid()}`);
    expect(guidance).toMatch(/credential/i);
  });

  it("refuses a query string or a fragment", () => {
    reject(`${syntheticWebhookUrl()}?dry_run=1`);
    reject(`${syntheticWebhookUrl()}#anchor`);
  });

  it("refuses a path that is not a webhook path", () => {
    reject(`https://usetrmnl.com/plugins/${syntheticUuid()}`);
    reject("https://usetrmnl.com/");
  });

  it("refuses a final segment that is not an identifier", () => {
    const { guidance } = reject("https://usetrmnl.com/api/custom_plugins/my-plugin");
    expect(guidance).toMatch(/UUID/i);
  });

  it("refuses an empty answer and a non-URL", () => {
    reject("");
    reject("   ");
    reject("usetrmnl.com/api/custom_plugins");
  });

  it("accepts an unknown host but says so", () => {
    const result = validateWebhookUrl(syntheticWebhookUrl("trmnl.example.net"));
    expect(result.ok).toBe(true);
    expect(result.ok && result.warnings).toHaveLength(1);
    expect(result.ok && result.warnings[0]).toMatch(/self-hosted/i);
  });
});

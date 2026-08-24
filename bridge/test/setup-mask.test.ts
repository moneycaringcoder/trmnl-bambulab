import { describe, expect, it } from "vitest";
import { maskEmail, maskIdentifier, maskSecret, maskWebhookUrl } from "../src/setup/mask.ts";
import { LAN_CODE, PRINTER_SERIAL, syntheticWebhookUrl } from "./synthetic-values.ts";

describe("maskSecret", () => {
  it("reveals nothing at all", () => {
    expect(maskSecret(LAN_CODE)).toBe("(set, hidden)");
    expect(maskSecret("a")).toBe("(set, hidden)");
  });

  it("distinguishes absent from present", () => {
    expect(maskSecret(null)).toBe("(not set)");
    expect(maskSecret(undefined)).toBe("(not set)");
    expect(maskSecret("   ")).toBe("(not set)");
  });
});

describe("maskIdentifier", () => {
  it("keeps only a three-character tail", () => {
    const masked = maskIdentifier(PRINTER_SERIAL);
    expect(masked).not.toContain(PRINTER_SERIAL);
    expect(masked.endsWith(PRINTER_SERIAL.slice(-3))).toBe(true);
    expect(masked.length).toBeLessThan(PRINTER_SERIAL.length + 8);
  });

  it("hides a short value completely", () => {
    expect(maskIdentifier("abc")).toBe("\u2022\u2022\u2022");
    expect(maskIdentifier("1234567")).toBe("\u2022".repeat(7));
  });

  it("reports an absent value", () => {
    expect(maskIdentifier("")).toBe("(not set)");
    expect(maskIdentifier(null)).toBe("(not set)");
  });
});

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("printer-owner@example.com")).toBe("p\u2022\u2022\u2022@example.com");
  });

  it("falls back to a secret for anything that is not an address", () => {
    expect(maskEmail("no-at-sign")).toBe("(set, hidden)");
    expect(maskEmail("@example.com")).toBe("(set, hidden)");
    expect(maskEmail("owner@")).toBe("(set, hidden)");
    expect(maskEmail(null)).toBe("(not set)");
  });
});

describe("maskWebhookUrl", () => {
  it("drops the plugin-setting UUID and keeps the shape", () => {
    const url = syntheticWebhookUrl();
    const masked = maskWebhookUrl(url);
    expect(masked).toBe("https://usetrmnl.com/api/custom_plugins/\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022");
    expect(masked).not.toContain("0000");
  });

  it("handles a bare origin and an unparseable value", () => {
    expect(maskWebhookUrl("https://usetrmnl.com")).toBe(
      "https://usetrmnl.com/\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022",
    );
    expect(maskWebhookUrl("not a url")).toBe("(set, hidden)");
    expect(maskWebhookUrl("")).toBe("(not set)");
  });
});

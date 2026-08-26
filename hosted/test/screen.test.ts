import { describe, expect, it } from "vitest";

import { serializeScreen } from "@trmnl-bambulab/core/hosted/screen";

const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);

describe("serializeScreen", () => {
  it("drops unsupported nulls from the exact stored body", () => {
    const result = serializeScreen(
      {
        v: 1,
        printers: [{ name: "Demo", progress: null, nested: { value: null } }],
      },
      NOW,
      2_000,
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("screen unexpectedly exceeded its limit");
    expect(JSON.parse(result.screen.body)).toEqual({
      v: 1,
      printers: [{ name: "Demo", nested: {} }],
    });
    expect(result.bytes).toBe(new TextEncoder().encode(result.screen.body).byteLength);
    expect(result.screen.renderedAt).toBe(NOW);
  });

  it("accepts an exact byte limit and refuses one byte less", () => {
    const variables = { message: "plain-ascii" };
    const body = JSON.stringify(variables);
    const bytes = new TextEncoder().encode(body).byteLength;

    expect(serializeScreen(variables, NOW, bytes)).toMatchObject({
      kind: "ready",
      bytes,
    });
    expect(serializeScreen(variables, NOW, bytes - 1)).toEqual({
      kind: "too-large",
      bytes,
    });
  });

  it("measures multibyte UTF-8 rather than JavaScript characters", () => {
    const variables = { message: "é" };
    const body = JSON.stringify(variables);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(body.length);

    const result = serializeScreen(variables, NOW, body.length);
    expect(result.kind).toBe("too-large");
  });

  it("refuses invalid time and size invariants", () => {
    expect(() => serializeScreen({}, -1, 1)).toThrow("render time");
    expect(() => serializeScreen({}, NOW, 0)).toThrow("payload limit");
  });
});

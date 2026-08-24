import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_PAYLOAD_BYTES } from "../src/setup/config.ts";
import { loadSyntheticPayload } from "../src/setup/synthetic.ts";

const FORBIDDEN_KEYS = ["serial", "dev_id", "device_id", "access_code", "ip", "host", "token"];

describe("loadSyntheticPayload", () => {
  it("wraps the fixture in the TRMNL merge_variables envelope", () => {
    const payload = loadSyntheticPayload();
    expect(Object.keys(payload.body)).toEqual(["merge_variables"]);
    expect(payload.body.merge_variables).toMatchObject({
      schema_version: 1,
      connection: { mode: "cloud" },
      job: { state: "printing" },
    });
  });

  it("fits under the standard TRMNL size ceiling", () => {
    const payload = loadSyntheticPayload();
    expect(payload.bytes).toBe(Buffer.byteLength(payload.serialized, "utf8"));
    expect(payload.bytes).toBeLessThan(DEFAULT_MAX_PAYLOAD_BYTES);
  });

  it("carries no identifier a real printer would have", () => {
    const serialized = loadSyntheticPayload().serialized;
    for (const key of FORBIDDEN_KEYS) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });
});

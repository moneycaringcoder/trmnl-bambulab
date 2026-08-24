import { describe, expect, it } from "vitest";
import {
  CLOUD_HTTP_CAPABILITIES,
  parseBindReport,
  parseCurrentPrint,
} from "../src/normalize/cloud-http.ts";
import { DEVICE_ID, loadCloudFixture } from "./synthetic-values.ts";

function fixture(name: string): unknown {
  return loadCloudFixture(name, import.meta.url);
}

describe("parseBindReport", () => {
  it("keeps a good device when a sibling entry is malformed", () => {
    const devices = parseBindReport(fixture("bind"));

    expect(devices.size).toBe(1);
    expect(devices.get(DEVICE_ID)).toEqual({
      printer: {
        name: "Workshop printer",
        model: "Synthetic printer model",
        online: true,
      },
      job: { state: "idle", rawState: "IDLE" },
    });
  });

  it("uses the product name only when the preferred model name is absent", () => {
    const devices = parseBindReport({
      devices: [{ dev_id: DEVICE_ID, dev_product_name: "Synthetic fallback model" }],
    });

    expect(devices.get(DEVICE_ID)?.printer).toEqual({ model: "Synthetic fallback model" });
  });

  // A field the cloud did not mention is omitted, not nulled. The coordinator
  // treats a null as news and would let it erase a name learned from the other
  // endpoint, so silence here has to stay silence.
  it("omits an unmentioned field rather than reporting it as absent", () => {
    const devices = parseBindReport({
      devices: [
        {
          dev_id: DEVICE_ID,
          name: 9,
          dev_model_name: [],
          dev_product_name: false,
          online: "yes",
          print_status: {},
        },
      ],
    });

    expect(devices.get(DEVICE_ID)).toEqual({});
  });

  it("returns an empty map for an unusable response", () => {
    expect(parseBindReport(null).size).toBe(0);
    expect(parseBindReport({ devices: "not-an-array" }).size).toBe(0);
  });
});

describe("parseCurrentPrint", () => {
  it("suppresses a private job name unless export is explicitly enabled", () => {
    const payload = fixture("print-running");
    const suppressed = parseCurrentPrint(payload, { exportJobName: false }).get(DEVICE_ID);
    const exported = parseCurrentPrint(payload, { exportJobName: true }).get(DEVICE_ID);

    expect(suppressed).toEqual({
      printer: { name: "Workshop printer", online: true },
      job: { state: "printing", rawState: "RUNNING", progress: 42 },
    });
    expect(suppressed?.job).not.toHaveProperty("name");
    expect(exported?.job?.name).toBe("Synthetic example job");
  });

  it("omits an opted-in job name the cloud did not send", () => {
    const devices = parseCurrentPrint(
      { devices: [{ dev_id: DEVICE_ID, task_status: "IDLE" }] },
      { exportJobName: true },
    );
    expect(devices.get(DEVICE_ID)?.job).not.toHaveProperty("name");
  });

  it("never fabricates idle progress or unsupported layer data as zero", () => {
    const idle = parseCurrentPrint(fixture("print-idle"), { exportJobName: false }).get(DEVICE_ID);

    expect(idle?.job?.state).toBe("idle");
    expect(idle?.job?.progress ?? null).toBeNull();
    expect(idle?.job?.layer?.current ?? null).toBeNull();
    expect(idle?.job?.progress).not.toBe(0);
    expect(idle?.job).not.toHaveProperty("layer");
  });

  it("clamps reported progress before it can become a CSS width", () => {
    const high = parseCurrentPrint(
      { devices: [{ dev_id: DEVICE_ID, progress: 180 }] },
      { exportJobName: false },
    );
    expect(high.get(DEVICE_ID)?.job?.progress).toBe(100);
  });

  it("does not expose identifiers or unsupported HTTP telemetry", () => {
    const state = parseCurrentPrint(fixture("print-running"), { exportJobName: true }).get(DEVICE_ID);

    expect(state).not.toHaveProperty("task_id");
    expect(state).not.toHaveProperty("project");
    expect(state?.job).not.toHaveProperty("layer");
    expect(state).not.toHaveProperty("temperatures");
  });

  it("returns an empty map for malformed response entries", () => {
    expect(
      parseCurrentPrint({ devices: [{ dev_id: 7 }] }, { exportJobName: false }).size,
    ).toBe(0);
    expect(parseCurrentPrint({}, { exportJobName: false }).size).toBe(0);
  });
});

describe("CLOUD_HTTP_CAPABILITIES", () => {
  it("describes the metadata-only HTTP path honestly", () => {
    expect(CLOUD_HTTP_CAPABILITIES).toEqual({
      realtimeTelemetry: false,
      temperatures: false,
      filament: false,
      alerts: false,
      deviceDiscovery: true,
      projectMetadata: true,
      coverImage: false,
    });
  });
});

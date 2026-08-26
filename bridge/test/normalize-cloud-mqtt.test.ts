import { describe, expect, it } from "vitest";
import {
  CLOUD_MQTT_CAPABILITIES,
  parseReport,
} from "@trmnl-bambulab/core/telemetry/normalize/cloud-mqtt";
import { loadCloudFixture } from "./synthetic-values.ts";

function fixture(name: string): unknown {
  return loadCloudFixture(name, import.meta.url);
}

describe("parseReport", () => {
  it("normalizes a complete X1-style report without exporting its job name", () => {
    expect(parseReport(fixture("mqtt-report-full"))).toEqual({
      job: {
        state: "printing",
        rawState: "RUNNING",
        progress: 42,
        layer: { current: 17, total: 100 },
        remainingMinutes: 76,
        stageCode: "2",
      },
      temperatures: {
        nozzle: 211,
        nozzleTarget: 220,
        bed: 60,
        bedTarget: 60,
      },
      alerts: { active: false, hms: [], printError: null },
    });
  });

  it("exports a job name only after an explicit opt-in", () => {
    const payload = fixture("mqtt-report-full");
    expect(parseReport(payload)?.job).not.toHaveProperty("name");
    expect(parseReport(payload, { exportJobName: true })?.job?.name).toBe(
      "Synthetic example job",
    );
  });

  it("keeps unreported P1 delta fields absent rather than erasing prior values", () => {
    const delta = parseReport(fixture("mqtt-report-delta"));

    expect(delta).toEqual({
      job: { state: "paused", rawState: "PAUSE", progress: 43 },
      temperatures: { nozzle: 212 },
    });
    expect(delta?.job).not.toHaveProperty("layer");
    expect(delta?.job).not.toHaveProperty("remainingMinutes");
    expect(delta?.temperatures).not.toHaveProperty("bed");
    expect(delta).not.toHaveProperty("alerts");
    expect(delta?.job?.layer).toBeUndefined();
  });

  it("normalizes independent HMS and print-error alerts", () => {
    expect(parseReport(fixture("mqtt-report-alert"))?.alerts).toEqual({
      active: true,
      hms: ["0300-1100-0002-0002"],
      printError: "00000005",
    });
  });

  it("normalizes string HMS codes and caps the display list at three", () => {
    const report = parseReport({
      print: {
        hms: [
          "HMS_0300_1100_0002_0002",
          "not-hex",
          { attr: 0x03000000, code: 1 },
          { attr: 0x05000000, code: 2 },
          { attr: 0x07000000, code: 3 },
        ],
      },
    });

    expect(report?.alerts).toEqual({
      active: true,
      hms: ["0300-1100-0002-0002", "0300-0000-0000-0001", "0500-0000-0000-0002"],
    });
  });

  it("renders a nonzero signed print error as unsigned eight-digit hex", () => {
    expect(parseReport({ print: { print_error: -1 } })?.alerts).toEqual({
      active: true,
      printError: "FFFFFFFF",
    });
  });

  it("lets one malformed optional field fall away without discarding the report", () => {
    expect(
      parseReport({
        print: {
          gcode_state: "RUNNING",
          mc_percent: "42",
          layer_num: null,
          stg_cur: {},
          nozzle_temper: "hot",
          hms: "not-an-array",
          print_error: "5",
        },
      }),
    ).toEqual({ job: { state: "printing", rawState: "RUNNING" } });
  });

  // A report that yielded nothing is not an observation. Recording one would
  // register a printer the coordinator has learned nothing about, which then
  // reads on the display as a printer whose data has gone stale.
  it("returns null for a report that told us nothing", () => {
    expect(parseReport({ print: {} })).toBeNull();
    expect(parseReport({ print: { unrecognized_field: 1 } })).toBeNull();
  });

  it("returns null when there is no usable print object", () => {
    expect(parseReport(null)).toBeNull();
    expect(parseReport({})).toBeNull();
    expect(parseReport({ print: null })).toBeNull();
    expect(parseReport({ print: "not-an-object" })).toBeNull();
  });
});

describe("CLOUD_MQTT_CAPABILITIES", () => {
  it("describes the read-only live report path honestly", () => {
    expect(CLOUD_MQTT_CAPABILITIES).toEqual({
      realtimeTelemetry: true,
      temperatures: true,
      filament: false,
      alerts: true,
      deviceDiscovery: false,
      projectMetadata: false,
      coverImage: false,
    });
  });
});

import { describe, expect, it } from "vitest";

import { renderScreenMarkup } from "../src/markup.js";

const printingPayload: Record<string, unknown> = {
  v: 1,
  updated_at: "2026-01-01T00:00Z",
  printers: [
    {
      state: "printing",
      raw_state: "SYNTHETIC_RUNNING",
      name: "Workshop Printer",
      model: "Demo Model A",
      online: true,
      stale: false,
      progress: 42,
      layer: 81,
      layers: 194,
      remaining: "1h 16m",
      stage: "Printing",
      nozzle: 220,
      nozzle_target: 220,
      bed: 60,
      bed_target: 60,
      material: "Demo PLA",
      job: null,
      alert: null,
    },
    {
      state: "printing",
      raw_state: "SYNTHETIC_RUNNING",
      name: "Studio Printer",
      model: "Demo Model B",
      online: true,
      stale: false,
      progress: 73,
      layer: 120,
      layers: 164,
      remaining: "34m",
      stage: "Finishing",
      nozzle: 215,
      nozzle_target: 215,
      bed: 55,
      bed_target: 55,
      material: "Demo PETG",
      job: "Synthetic calibration",
      alert: null,
    },
  ],
  hidden: 0,
  cloud: "connected",
};

describe("renderScreenMarkup", () => {
  it("renders all four marketplace layouts for multiple printing printers", async () => {
    const result = await renderScreenMarkup(printingPayload);

    expect(result.markup).toContain('<div class="view view--full">');
    expect(result.markup_half_horizontal).toContain(
      '<div class="view view--half_horizontal">',
    );
    expect(result.markup_half_vertical).toContain(
      '<div class="view view--half_vertical">',
    );
    expect(result.markup_quadrant).toContain(
      '<div class="view view--quadrant">',
    );
    for (const markup of Object.values(result)) {
      expect(markup.trim().length).toBeGreaterThan(0);
      expect(markup).not.toContain("<html");
      expect(markup).not.toContain("<head");
    }
  });

  it("renders an idle printer without fabricating progress", async () => {
    const result = await renderScreenMarkup({
      ...printingPayload,
      printers: [
        {
          state: "idle",
          raw_state: "SYNTHETIC_IDLE",
          name: "Quiet Printer",
          online: true,
          stale: false,
          progress: null,
          layer: null,
          layers: null,
          remaining: null,
          stage: null,
          nozzle: null,
          nozzle_target: null,
          bed: null,
          bed_target: null,
          material: null,
          job: null,
          alert: null,
        },
      ],
    });

    for (const markup of Object.values(result)) {
      expect(markup).toContain("Quiet Printer");
      expect(markup).toContain("Ready");
      expect(markup).not.toContain("0%");
      expect(markup).not.toContain("progress-bar");
    }
  });

  it.each([
    ["unknown", false],
    ["printing", true],
  ])("renders a dash for an unreadable %s printer", async (state, stale) => {
    const result = await renderScreenMarkup({
      ...printingPayload,
      printers: [
        {
          state,
          raw_state: "SYNTHETIC_UNREADABLE",
          name: "Unavailable Printer",
          online: state !== "unknown",
          stale,
          progress: 42,
          layer: 81,
          layers: 194,
          remaining: "1h 16m",
          stage: "Printing",
          nozzle: 220,
          nozzle_target: 220,
          bed: 60,
          bed_target: 60,
          material: "Demo PLA",
          job: null,
          alert: null,
        },
      ],
    });

    expect(result.markup).toContain("&mdash;");
    expect(result.markup).not.toContain("42%");
    expect(result.markup).not.toContain("progress-bar");
  });
});

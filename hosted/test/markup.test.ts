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

  it("escapes malicious printer, job, stage, and alert text exactly once", async () => {
    const result = await renderScreenMarkup({
      ...printingPayload,
      printers: [
        {
          state: "printing",
          raw_state: "SYNTHETIC_RUNNING",
          name: '<strong data-name="bad">Printer & Co</strong>',
          online: true,
          stale: false,
          progress: 42,
          layer: 81,
          layers: 194,
          remaining: "1h 16m",
          stage: "<svg onload=stage()>",
          nozzle: 220,
          nozzle_target: 220,
          bed: 60,
          bed_target: 60,
          material: "Demo PLA",
          job: "</span><script>job()</script>",
          alert: "<img src=x onerror=alert(1)>",
        },
      ],
    });

    for (const markup of Object.values(result)) {
      expect(markup).not.toContain('<strong data-name="bad">');
      expect(markup).not.toContain("<script>");
      expect(markup).not.toContain("<img src=x");
      expect(markup).not.toContain("<svg onload");
      expect(markup).toContain("&lt;strong data-name=&#34;bad&#34;&gt;Printer &amp; Co&lt;/strong&gt;");
      expect(markup).not.toContain("&amp;lt;");
    }
    expect(result.markup).toContain("&lt;/span&gt;&lt;script&gt;job()&lt;/script&gt;");
    expect(result.markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(result.markup).toContain("&middot;");
    expect(result.markup).not.toContain("&amp;middot;");
  });

  it("distinguishes unavailable states, hides old metrics, and names three printers", async () => {
    const printers = [
      { state: "printing", stale: true, name: "Stale Alpha", progress: 41 },
      { state: "offline", stale: false, name: "Offline Beta", progress: 42 },
      { state: "unknown", stale: false, name: "Unknown Gamma", progress: 43 },
    ].map((printer) => ({
      ...printer,
      raw_state: "SYNTHETIC_UNREADABLE",
      online: false,
      layer: 81,
      layers: 194,
      remaining: "41m old",
      stage: "Old stage",
      nozzle: 220,
      nozzle_target: 220,
      bed: 60,
      bed_target: 60,
      material: "Old material",
      job: "Old job",
      alert: "Old alert",
    }));

    const result = await renderScreenMarkup({ ...printingPayload, printers });

    for (const markup of Object.values(result)) {
      expect(markup).toContain("Reading old");
      expect(markup).toContain("Offline");
      expect(markup).toContain("Unknown");
      expect(markup).toContain("Stale Alpha");
      expect(markup).toContain("Offline Beta");
      expect(markup).toContain("Unknown Gamma");
      expect(markup).not.toContain("41%");
      expect(markup).not.toContain("42%");
      expect(markup).not.toContain("43%");
      expect(markup).not.toContain("progress-bar");
      expect(markup).not.toContain("41m old");
      expect(markup).not.toContain("Old stage");
      expect(markup).not.toContain("Old material");
      expect(markup).not.toContain("Old job");
      expect(markup).not.toContain("Old alert");
      expect(markup).not.toContain("! ALERT");
    }
  });
});

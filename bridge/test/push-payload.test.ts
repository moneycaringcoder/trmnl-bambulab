import { describe, expect, it } from "vitest";
import {
  buildWebhookPayload,
  type PayloadOptions,
  type PayloadResult,
} from "../src/push/payload.ts";
import type { DisplayState, Snapshot } from "../src/types.ts";
import { DEVICE_ID } from "./synthetic-values.ts";

const NOW = Date.UTC(2026, 0, 1, 12, 34, 56);
const ROOMY_OPTIONS: PayloadOptions = {
  now: NOW,
  cloud: "connected",
  maxBytes: 10_000,
  exportJobName: false,
};

interface SnapshotOptions {
  key?: string;
  name?: string | null;
  state?: DisplayState;
  online?: boolean | null;
  stale?: boolean;
  receivedAt?: number | null;
  progress?: number | null;
  remainingMinutes?: number | null;
  stage?: string | null;
  layer?: number | null;
  layers?: number | null;
  nozzle?: number | null;
  nozzleTarget?: number | null;
  bed?: number | null;
  bedTarget?: number | null;
  jobName?: string | null;
  hms?: string[];
  printError?: string | null;
}

function snapshot(options: SnapshotOptions = {}): Snapshot {
  const key = options.key ?? DEVICE_ID;
  const state = options.state ?? "printing";
  const receivedAt = options.receivedAt === undefined ? NOW : options.receivedAt;
  return {
    printerKey: key,
    state: {
      printer: {
        name: options.name === undefined ? "Synthetic Printer" : options.name,
        model: "Synthetic Model",
        online: options.online === undefined ? true : options.online,
        stale: options.stale ?? false,
      },
      job: {
        state,
        rawState: `SYNTHETIC_${state.toUpperCase()}`,
        name: options.jobName === undefined ? "Private synthetic model" : options.jobName,
        progress: options.progress === undefined ? 67 : options.progress,
        remainingMinutes:
          options.remainingMinutes === undefined ? 76 : options.remainingMinutes,
        stage: options.stage === undefined ? "Printing synthetic outer wall" : options.stage,
        stageCode: "SYNTHETIC_STAGE",
        layer: {
          current: options.layer === undefined ? 123 : options.layer,
          total: options.layers === undefined ? 456 : options.layers,
        },
      },
      temperatures: {
        nozzle: options.nozzle === undefined ? 219.5 : options.nozzle,
        nozzleTarget: options.nozzleTarget === undefined ? 220 : options.nozzleTarget,
        bed: options.bed === undefined ? 59.5 : options.bed,
        bedTarget: options.bedTarget === undefined ? 60 : options.bedTarget,
      },
      material: { source: "Synthetic slot", type: "Synthetic PLA", color: "#ABCDEF" },
      project: { coverUrl: "https://example.invalid/private-cover", weightGrams: 12, lengthMm: 34, bedType: "Synthetic plate" },
      alerts: {
        active: (options.hms?.length ?? 1) > 0 || options.printError !== null,
        hms: options.hms ?? ["SYNTHETIC_HMS_NOTICE"],
        printError: options.printError === undefined ? null : options.printError,
      },
      updatedAt: "2026-01-01T12:34:00Z",
    },
    provenance:
      receivedAt === null
        ? {}
        : {
            "job.state": { providerId: "cloud-mqtt", receivedAt },
            "printer.name": { providerId: "cloud-http", receivedAt: receivedAt - 1_000 },
          },
  };
}

function options(overrides: Partial<PayloadOptions> = {}): PayloadOptions {
  return { ...ROOMY_OPTIONS, ...overrides };
}

function serializedPrinters(result: PayloadResult): Record<string, unknown>[] {
  const parsed = JSON.parse(result.serialized) as {
    merge_variables: { printers: Record<string, unknown>[] };
  };
  return parsed.merge_variables.printers;
}

describe("buildWebhookPayload — ordering and privacy", () => {
  it("orders every state by viewer priority", () => {
    const expected: DisplayState[] = [
      "printing",
      "paused",
      "preparing",
      "finished",
      "failed",
      "idle",
      "offline",
      "unknown",
    ];

    for (let index = 0; index < expected.length - 1; index += 1) {
      const higher = expected[index];
      const lower = expected[index + 1];
      if (higher === undefined || lower === undefined) throw new Error("missing state fixture");
      const result = buildWebhookPayload(
        [
          snapshot({ key: `${DEVICE_ID}-${lower}`, state: lower }),
          snapshot({ key: `${DEVICE_ID}-${higher}`, state: higher }),
        ],
        ROOMY_OPTIONS,
      );
      expect(result.variables.printers.map((printer) => printer.state)).toEqual([higher, lower]);
    }
  });

  it("breaks state ties by name case-insensitively and puts a nameless printer last", () => {
    const result = buildWebhookPayload(
      [
        snapshot({ key: `${DEVICE_ID}-none`, name: null }),
        snapshot({ key: `${DEVICE_ID}-beta`, name: "Beta Printer" }),
        snapshot({ key: `${DEVICE_ID}-alpha`, name: "alpha printer" }),
      ],
      ROOMY_OPTIONS,
    );

    expect(result.variables.printers.map((printer) => printer.name)).toEqual([
      "alpha printer",
      "Beta Printer",
      null,
    ]);
  });

  it("shows no more than three printers without padding and counts hidden printers", () => {
    const four = ["Delta", "Charlie", "Bravo", "Alpha"].map((name, index) =>
      snapshot({ key: `${DEVICE_ID}-${index}`, name, state: "idle" }),
    );
    const result = buildWebhookPayload(four, ROOMY_OPTIONS);

    expect(result.variables.printers.map((printer) => printer.name)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect(result.variables.hidden).toBe(1);
    expect(buildWebhookPayload([], ROOMY_OPTIONS).variables.printers).toEqual([]);
  });

  it("never serializes an internal printer key, provenance, task id, or cover URL", () => {
    const result = buildWebhookPayload([snapshot()], ROOMY_OPTIONS);

    expect(JSON.stringify(result.body)).not.toContain(DEVICE_ID);
    expect(result.serialized).not.toContain("provenance");
    expect(result.serialized).not.toContain("printerKey");
    expect(result.serialized).not.toContain("private-cover");
    expect(result.serialized).not.toContain("task_id");
  });

  it("exports a job name only after explicit opt-in", () => {
    const hidden = buildWebhookPayload([snapshot()], ROOMY_OPTIONS);
    const exported = buildWebhookPayload(
      [snapshot()],
      options({ exportJobName: true }),
    );

    expect(hidden.variables.printers[0]?.job).toBeNull();
    expect(serializedPrinters(hidden)[0]).not.toHaveProperty("job");
    expect(exported.variables.printers[0]?.job).toBe("Private synthetic model");
  });
});

describe("buildWebhookPayload — display translation", () => {
  it("serializes an idle printer without invented progress, layers, or remaining time", () => {
    const result = buildWebhookPayload(
      [
        snapshot({
          state: "idle",
          progress: null,
          remainingMinutes: null,
          stage: null,
          layer: null,
          layers: null,
          hms: [],
          printError: null,
        }),
      ],
      ROOMY_OPTIONS,
    );
    const printer = serializedPrinters(result)[0];

    expect(result.variables.printers[0]).toMatchObject({
      progress: null,
      layer: null,
      layers: null,
      remaining: null,
    });
    for (const key of ["progress", "layer", "layers", "remaining"]) {
      expect(printer).not.toHaveProperty(key);
    }
  });

  // The dangerous case is not a null coming through; it is a real number
  // surviving a state change. An idle printer holds whatever it last reported,
  // and passing that on would show a ready printer claiming to be 87% through
  // a job it finished yesterday.
  it("drops last night's progress once a printer goes idle", () => {
    const held = { progress: 87, layer: 300, layers: 300, remainingMinutes: 4, jobName: "Secret" };

    for (const state of ["idle", "offline", "unknown"] as const) {
      const result = buildWebhookPayload([snapshot({ state, ...held })], {
        ...ROOMY_OPTIONS,
        exportJobName: true,
      });

      expect(result.variables.printers[0]).toMatchObject({
        state,
        progress: null,
        layer: null,
        layers: null,
        remaining: null,
        stage: null,
        job: null,
      });
    }
  });

  it("keeps the numbers on a finished or failed print, where they explain it", () => {
    const result = buildWebhookPayload(
      [
        snapshot({ key: `${DEVICE_ID}-f`, state: "failed", progress: 47, layer: 120, layers: 300 }),
      ],
      ROOMY_OPTIONS,
    );
    expect(result.variables.printers[0]).toMatchObject({ progress: 47, layer: 120, layers: 300 });
  });

  // Not a print metric: an idle printer really does have a warm bed, and that
  // is worth seeing.
  it("keeps temperatures on an idle printer", () => {
    const result = buildWebhookPayload(
      [snapshot({ state: "idle", nozzle: 24, bed: 23 })],
      ROOMY_OPTIONS,
    );
    expect(result.variables.printers[0]).toMatchObject({ nozzle: 24, bed: 23 });
  });

  it("formats remaining minutes without asking Liquid to calculate", () => {
    const result = buildWebhookPayload(
      [
        snapshot({ key: `${DEVICE_ID}-minutes`, name: "A", remainingMinutes: 4 }),
        snapshot({ key: `${DEVICE_ID}-hours`, name: "B", remainingMinutes: 60 }),
        snapshot({ key: `${DEVICE_ID}-mixed`, name: "C", remainingMinutes: 76 }),
      ],
      ROOMY_OPTIONS,
    );

    expect(result.variables.printers.map((printer) => printer.remaining)).toEqual([
      "4m",
      "1h",
      "1h 16m",
    ]);
    expect(result.variables.updated_at).toBe("2026-01-01T12:34Z");
  });

  it("combines HMS and print-error codes into one short alert line", () => {
    const result = buildWebhookPayload(
      [
        snapshot({
          hms: ["SYNTHETIC_HMS_ONE", "SYNTHETIC_HMS_TWO"],
          printError: "00ABCDEF",
        }),
      ],
      ROOMY_OPTIONS,
    );
    expect(result.variables.printers[0]?.alert).toBe(
      "SYNTHETIC_HMS_ONE, SYNTHETIC_HMS_TWO, 00ABCDEF",
    );
  });

  // Staleness is the coordinator's decision, taken against its own window when
  // it builds the snapshot. This module passes it through; asking the question
  // twice would let the two answers disagree.
  it("passes the coordinator's stale verdict through untouched", () => {
    const result = buildWebhookPayload(
      [
        snapshot({ key: `${DEVICE_ID}-fresh`, stale: false, online: true }),
        snapshot({ key: `${DEVICE_ID}-stale`, stale: true, online: true }),
      ],
      ROOMY_OPTIONS,
    );

    expect(
      result.variables.printers.map((printer) => ({
        stale: printer.stale,
        online: printer.online,
      })),
    ).toEqual([
      { stale: false, online: true },
      { stale: true, online: true },
    ]);
  });
});

describe("buildWebhookPayload — size ceiling", () => {
  it("fits three realistic worst-case printers in 1338 bytes, below 2048", () => {
    const snapshots = [4, 60, 76].map((remainingMinutes, index) =>
      snapshot({
        key: `${DEVICE_ID}-${index}`,
        name: `Synthetic Production Printer ${index + 1} With A Long Display Name`,
        remainingMinutes,
        layer: 789 - index,
        layers: 999,
        hms: [`SYNTHETIC_HMS_NOTICE_${index + 1}_REQUIRES_ATTENTION`],
      }),
    );
    const result = buildWebhookPayload(snapshots, options({ maxBytes: 2048 }));

    expect(result.sendable).toBe(true);
    expect(result.variables.printers).toHaveLength(3);
    expect(result.shed).toEqual([]);
    expect(result.bytes, `three-printer payload grew to ${result.bytes} bytes`).toBe(1338);
  });

  it("sheds stage before target temperatures and stops after exactly two sheds", () => {
    const withoutFirstTwoDetails = snapshot({
      stage: null,
      nozzleTarget: null,
      bedTarget: null,
    });
    const exactCeiling = buildWebhookPayload(
      [withoutFirstTwoDetails],
      ROOMY_OPTIONS,
    ).bytes;
    const result = buildWebhookPayload(
      [snapshot()],
      options({ maxBytes: exactCeiling }),
    );

    expect(result.sendable).toBe(true);
    expect(result.shed).toEqual(["stage", "target_temperatures"]);
    expect(result.bytes).toBe(exactCeiling);
    expect(result.variables.printers[0]).toMatchObject({
      stage: null,
      nozzle_target: null,
      bed_target: null,
      nozzle: 219.5,
      bed: 59.5,
    });
  });

  it("removes the least-interesting printer only after optional detail is absent", () => {
    const detailFree = (key: string, name: string) =>
      snapshot({
        key,
        name,
        state: "idle",
        stage: null,
        nozzle: null,
        nozzleTarget: null,
        bed: null,
        bedTarget: null,
      });
    const first = detailFree(`${DEVICE_ID}-first`, "Alpha");
    const second = detailFree(`${DEVICE_ID}-second`, "Beta");
    const onePrinterBytes = buildWebhookPayload([first], ROOMY_OPTIONS).bytes;
    const result = buildWebhookPayload(
      [first, second],
      options({ maxBytes: onePrinterBytes }),
    );

    expect(result.sendable).toBe(true);
    expect(result.shed).toEqual(["printer"]);
    expect(result.variables.printers.map((printer) => printer.name)).toEqual(["Alpha"]);
    expect(result.variables.hidden).toBe(1);
  });

  it("flags an irreducible one-printer body as not sendable", () => {
    const result = buildWebhookPayload([snapshot()], options({ maxBytes: 1 }));

    expect(result.sendable).toBe(false);
    expect(result.bytes).toBeGreaterThan(1);
    expect(result.variables.printers).toHaveLength(1);
    expect(result.shed).toEqual([
      "stage",
      "target_temperatures",
      "current_temperatures",
    ]);
  });
});

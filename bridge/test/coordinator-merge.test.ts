import { describe, expect, it } from "vitest";
import {
  AUTHORITY_WINDOW_MS,
  STALE_AFTER_MS,
  accept,
  emptyCoordinatorState,
  snapshotsFor,
  unknownPrinterState,
  type CoordinatorState,
} from "@trmnl-bambulab/core/telemetry/coordinator/merge";
import type {
  CapabilitySet,
  Observation,
  PartialPrinterState,
  ProviderId,
} from "@trmnl-bambulab/core/telemetry/types";

const KEY = "printer-a";
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60 * 1000;

const CAPABILITIES: CapabilitySet = {
  realtimeTelemetry: false,
  temperatures: false,
  filament: false,
  alerts: false,
  deviceDiscovery: true,
  projectMetadata: false,
  coverImage: false,
};

function observe(
  providerId: ProviderId,
  receivedAt: number,
  fields: PartialPrinterState,
  printerKey = KEY,
): Observation {
  return {
    providerId,
    printerKey,
    receivedAt,
    observedAt: null,
    fields,
    capabilities: CAPABILITIES,
  };
}

function fold(...observations: Observation[]): CoordinatorState {
  return observations.reduce(accept, emptyCoordinatorState());
}

function only(state: CoordinatorState, nowMs = T0 + MINUTE) {
  const [snapshot] = snapshotsFor(state, [KEY], nowMs);
  if (snapshot === undefined) throw new Error("expected one snapshot");
  return snapshot;
}

describe("accumulating partials", () => {
  it("fills in fields from separate reports without losing either", () => {
    const state = fold(
      observe("cloud-http", T0, { printer: { name: "Workshop printer", online: true } }),
      observe("cloud-mqtt", T0 + MINUTE, {
        job: { progress: 42, layer: { current: 81, total: 194 } },
      }),
    );

    const { state: merged } = only(state);
    expect(merged.printer.name).toBe("Workshop printer");
    expect(merged.printer.online).toBe(true);
    expect(merged.job.progress).toBe(42);
    expect(merged.job.layer).toEqual({ current: 81, total: 194 });
  });

  // A P1 reports only what changed, so most reports say almost nothing. If a
  // near-empty report erased the rest, the display would flicker back to
  // knowing nothing every few seconds.
  it("leaves a field alone when a later report does not mention it", () => {
    const state = fold(
      observe("cloud-mqtt", T0, {
        job: { progress: 42, layer: { current: 81, total: 194 } },
        temperatures: { nozzle: 220 },
      }),
      observe("cloud-mqtt", T0 + MINUTE, { job: { progress: 43 } }),
    );

    const { state: merged } = only(state);
    expect(merged.job.progress).toBe(43);
    expect(merged.job.layer.current).toBe(81);
    expect(merged.temperatures.nozzle).toBe(220);
  });

  it("takes an explicit null as news, because a provider can report absence", () => {
    const state = fold(
      observe("cloud-mqtt", T0, { job: { stage: "Printing" } }),
      observe("cloud-mqtt", T0 + MINUTE, { job: { stage: null } }),
    );
    expect(only(state).state.job.stage).toBeNull();
  });

  it("registers a printer on first mention", () => {
    const state = fold(observe("cloud-http", T0, { printer: { model: "A1" } }, "printer-b"));
    const [snapshot] = snapshotsFor(state, ["printer-b"], T0);
    expect(snapshot?.state.printer.model).toBe("A1");
  });

  it("keeps printers independent", () => {
    const state = fold(
      observe("cloud-mqtt", T0, { job: { progress: 10 } }, "printer-a"),
      observe("cloud-mqtt", T0, { job: { progress: 90 } }, "printer-b"),
    );
    const [first, second] = snapshotsFor(state, ["printer-a", "printer-b"], T0);
    expect(first?.state.job.progress).toBe(10);
    expect(second?.state.job.progress).toBe(90);
  });

  it("never mutates the state it was given", () => {
    const first = fold(observe("cloud-mqtt", T0, { job: { progress: 10 } }));
    const second = accept(first, observe("cloud-mqtt", T0 + MINUTE, { job: { progress: 20 } }));

    expect(first.printers[KEY]?.state.job.progress).toBe(10);
    expect(second.printers[KEY]?.state.job.progress).toBe(20);
  });
});

describe("who wins a disagreement", () => {
  // The cloud's task summary can say a job is running while the printer is
  // reporting a pause. Showing a moving printer that has actually stopped is
  // the worst available answer, so rank beats recency.
  it("keeps the live report even when the cloud summary is newer", () => {
    const state = fold(
      observe("cloud-mqtt", T0, { job: { state: "paused", rawState: "PAUSE" } }),
      observe("cloud-http", T0 + MINUTE, { job: { state: "printing", rawState: "RUNNING" } }),
    );

    const { state: merged } = only(state, T0 + 2 * MINUTE);
    expect(merged.job.state).toBe("paused");
    expect(merged.job.rawState).toBe("PAUSE");
  });

  it("lets the live report overwrite an older cloud summary", () => {
    const state = fold(
      observe("cloud-http", T0, { job: { state: "printing", rawState: "RUNNING" } }),
      observe("cloud-mqtt", T0 + MINUTE, { job: { state: "paused", rawState: "PAUSE" } }),
    );
    expect(only(state, T0 + 2 * MINUTE).state.job.state).toBe("paused");
  });

  it("lets the cloud summary back in once the live report has gone quiet", () => {
    const wentQuiet = T0;
    const state = fold(
      observe("cloud-mqtt", wentQuiet, { job: { state: "printing", rawState: "RUNNING" } }),
      observe("cloud-http", wentQuiet + AUTHORITY_WINDOW_MS + MINUTE, {
        job: { state: "finished", rawState: "SUCCESS" },
      }),
    );
    expect(only(state, wentQuiet + AUTHORITY_WINDOW_MS + 2 * MINUTE).state.job.state).toBe(
      "finished",
    );
  });

  it("holds the line right up to the edge of the authority window", () => {
    const state = fold(
      observe("cloud-mqtt", T0, { job: { state: "printing" } }),
      observe("cloud-http", T0 + AUTHORITY_WINDOW_MS, { job: { state: "finished" } }),
    );
    expect(only(state, T0 + AUTHORITY_WINDOW_MS).state.job.state).toBe("printing");
  });

  it("ignores a report that arrives out of order within one provider", () => {
    const state = fold(
      observe("cloud-mqtt", T0 + MINUTE, { job: { progress: 43 } }),
      observe("cloud-mqtt", T0, { job: { progress: 42 } }),
    );
    expect(only(state, T0 + 2 * MINUTE).state.job.progress).toBe(43);
  });
});

describe("snapshots", () => {
  it("answers for a chosen printer that has never reported", () => {
    const [snapshot] = snapshotsFor(emptyCoordinatorState(), ["never-seen"], T0);

    expect(snapshot?.printerKey).toBe("never-seen");
    expect(snapshot?.state.job.state).toBe("unknown");
    expect(snapshot?.state.printer.stale).toBe(true);
    expect(snapshot?.provenance).toEqual({});
  });

  // Unknown is not idle. A printer we have heard nothing from must not render
  // as a healthy printer sitting ready.
  it("does not describe an unheard-of printer as idle or healthy", () => {
    const state = unknownPrinterState(new Date(T0).toISOString());
    expect(state.job.state).toBe("unknown");
    expect(state.job.progress).toBeNull();
    expect(state.job.layer).toEqual({ current: null, total: null });
    expect(state.printer.online).toBeNull();
    expect(state.alerts.active).toBe(false);
  });

  it("answers in the order asked, not in the order observed", () => {
    const state = fold(
      observe("cloud-http", T0, { printer: { name: "second" } }, "b"),
      observe("cloud-http", T0, { printer: { name: "first" } }, "a"),
    );
    expect(snapshotsFor(state, ["a", "b"], T0).map((s) => s.state.printer.name)).toEqual([
      "first",
      "second",
    ]);
  });

  it("marks a printer stale once the newest field is too old", () => {
    const state = fold(observe("cloud-mqtt", T0, { job: { progress: 42 } }));

    expect(only(state, T0 + STALE_AFTER_MS).state.printer.stale).toBe(false);
    expect(only(state, T0 + STALE_AFTER_MS + 1).state.printer.stale).toBe(true);
  });

  // Stale and offline are different claims: one is about the bridge, the other
  // about the printer, and the display distinguishes them.
  it("leaves online alone when marking a printer stale", () => {
    const state = fold(observe("cloud-http", T0, { printer: { online: true } }));
    const snapshot = only(state, T0 + STALE_AFTER_MS + MINUTE);

    expect(snapshot.state.printer.stale).toBe(true);
    expect(snapshot.state.printer.online).toBe(true);
  });

  it("stamps every snapshot with the bridge clock rather than a report time", () => {
    const state = fold(observe("cloud-mqtt", T0, { job: { progress: 42 } }));
    expect(only(state, T0 + MINUTE).state.updatedAt).toBe(new Date(T0 + MINUTE).toISOString());
  });

  it("hands out copies, so a caller cannot write back into the accumulator", () => {
    const state = fold(observe("cloud-mqtt", T0, { job: { progress: 42 } }));
    const snapshot = only(state);
    snapshot.state.job.progress = 99;

    expect(only(state).state.job.progress).toBe(42);
  });
});

/**
 * Shared contracts for the bridge.
 *
 * Nothing in this file may import a transport. Providers depend on these
 * types; these types never depend on a provider.
 */

export const SCHEMA_VERSION = 1 as const;

/**
 * Which read path an observation came from. Both are Bambu Cloud; the
 * distinction exists because they disagree, and when they do, the live MQTT
 * report is the one to believe. It is internal: the display is only ever told
 * the coarse `cloud` status, never which path produced a field.
 */
export type ProviderId = "cloud-http" | "cloud-mqtt";

export type DisplayState =
  | "idle"
  | "preparing"
  | "printing"
  | "paused"
  | "finished"
  | "failed"
  | "offline"
  | "unknown";

export type ProviderStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "reauth_required"
  | "disabled";

export interface ProviderHealth {
  id: ProviderId;
  status: ProviderStatus;
  /** Bridge clock, epoch milliseconds. Never a remote timestamp. */
  lastObservationAt: number | null;
  lastErrorCategory: string | null;
}

export interface CapabilitySet {
  realtimeTelemetry: boolean;
  temperatures: boolean;
  filament: boolean;
  alerts: boolean;
  deviceDiscovery: boolean;
  projectMetadata: boolean;
  coverImage: boolean;
}

/**
 * A partial, already-normalized view of printer state from one provider.
 * Raw provider payloads never travel past the provider boundary.
 */
export interface Observation {
  providerId: ProviderId;
  /** Opaque internal key. Never a serial, never exported. */
  printerKey: string;
  /** Bridge clock at the moment the report was accepted, epoch milliseconds. */
  receivedAt: number;
  /** Provider-reported observation time when trustworthy, else null. */
  observedAt: number | null;
  fields: PartialPrinterState;
  capabilities: CapabilitySet;
}

export type Unsubscribe = () => void;

export interface BambuProvider {
  readonly id: ProviderId;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  health(): ProviderHealth;
  capabilities(): CapabilitySet;
  subscribe(onObservation: (observation: Observation) => void): Unsubscribe;
  refreshMetadata?(): Promise<void>;
}

/** Absent or unsupported is always `null`, never a fabricated zero. */
export interface PrinterState {
  printer: {
    name: string | null;
    model: string | null;
    online: boolean | null;
    stale: boolean;
  };
  job: {
    state: DisplayState;
    /** Raw provider token, preserved even when unknown. */
    rawState: string | null;
    name: string | null;
    progress: number | null;
    remainingMinutes: number | null;
    stage: string | null;
    stageCode: string | null;
    layer: { current: number | null; total: number | null };
  };
  temperatures: {
    nozzle: number | null;
    nozzleTarget: number | null;
    bed: number | null;
    bedTarget: number | null;
  };
  material: {
    source: string | null;
    type: string | null;
    color: string | null;
  };
  project: {
    coverUrl: string | null;
    weightGrams: number | null;
    lengthMm: number | null;
    bedType: string | null;
  };
  alerts: {
    active: boolean;
    /** Normalized HMS codes. Independent of printError. */
    hms: string[];
    /** Eight-digit hex when nonzero, else null. Independent of hms. */
    printError: string | null;
  };
  updatedAt: string;
}

export type PartialPrinterState = DeepPartial<PrinterState>;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/** Internal only. Never serialized into the webhook payload. */
export interface FieldProvenance {
  providerId: ProviderId;
  receivedAt: number;
}

/** One printer, fully merged and ready to render. */
export interface Snapshot {
  /** Opaque internal key. Never a serial, never exported. */
  printerKey: string;
  state: PrinterState;
  /** Diagnostics only. `buildWebhookPayload` must drop this. */
  provenance: Record<string, FieldProvenance>;
}

/**
 * The display side of the contract.
 *
 * Snake_case, because this is what Liquid reads. Short keys where the meaning
 * survives, because the whole body has to fit in 2 kB for a standard TRMNL
 * account and three printers.
 *
 * Anything the bridge has not been told is `null`, and a template that reads a
 * null must show a gap rather than a zero. Formatting that carries meaning is
 * done here rather than in Liquid: `remaining` is already "1h 16m", because
 * dividing minutes in a template is how a printer ends up claiming it will
 * finish in 0 hours.
 */
export interface WebhookPrinter {
  state: DisplayState;
  /** Raw provider token, preserved even when `state` is `unknown`. */
  raw_state: string | null;
  name: string | null;
  model: string | null;
  online: boolean | null;
  /** True when the newest observation for this printer is too old to trust. */
  stale: boolean;
  /** Whole percent, 0 to 100. */
  progress: number | null;
  layer: number | null;
  layers: number | null;
  /** Preformatted, e.g. "1h 16m" or "4m". */
  remaining: string | null;
  stage: string | null;
  nozzle: number | null;
  nozzle_target: number | null;
  bed: number | null;
  bed_target: number | null;
  material: string | null;
  /** Only when the user opted in, because a job name can be a private model. */
  job: string | null;
  /** One short line, or null. Never an empty string. */
  alert: string | null;
}

export interface WebhookVariables {
  v: typeof SCHEMA_VERSION;
  /** Bridge clock, ISO 8601 to the minute. Seconds would waste bytes. */
  updated_at: string;
  /** Ordered most interesting first. At most `MAX_PRINTERS_SHOWN` entries. */
  printers: WebhookPrinter[];
  /** How many chosen printers did not fit. Zero in the normal case. */
  hidden: number;
  /**
   * Coarse reachability of Bambu Cloud, so the display can distinguish a
   * printer being off from the bridge being unable to see anything. Never more
   * detail than this: the provider is not the user's business.
   */
  cloud: ProviderStatus;
}

/** Exactly what is POSTed to the TRMNL webhook. */
export interface WebhookPayload {
  merge_variables: WebhookVariables;
}

/**
 * Three fills an 800x480 screen without shrinking the numbers past reading
 * distance, and three is also what fits the 2 kB body.
 */
export const MAX_PRINTERS_SHOWN = 3;

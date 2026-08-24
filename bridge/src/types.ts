/**
 * Shared contracts for the bridge.
 *
 * Nothing in this file may import a transport. Providers depend on these
 * types; these types never depend on a provider.
 */

export const SCHEMA_VERSION = 1 as const;

export type ProviderId = "cloud";

/** Coarse mode exported to TRMNL. Never expose provider detail beyond this. */
export type ConnectionMode = "cloud" | "offline";

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

export interface Snapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  connection: {
    mode: ConnectionMode;
    local: ProviderStatus;
    cloud: ProviderStatus;
    cloudMetadataStale: boolean;
  };
  state: PrinterState;
  /** Diagnostics only. `buildWebhookPayload` must drop this. */
  provenance: Record<string, FieldProvenance>;
}

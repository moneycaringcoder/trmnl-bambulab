/**
 * One account's live telemetry session, from sealed token to stored render.
 *
 * This is the piece that closes the gap between the two tiers. Bambu's HTTP
 * interface carries a printer's name, whether it is online and whether it is
 * printing; progress, layer, remaining time and temperature arrive only over
 * MQTT, and MQTT wants a socket held open. A cron cannot hold one. This can,
 * because it runs on a machine that stays up. See `docs/COLLECTOR.md`.
 *
 * What it does not do matters as much. It never publishes to a printer, because
 * the client it uses has no publish encoder at all. It holds exactly one session
 * per account, because concurrent connections are what Bambu has objected to.
 * And it never logs a token, an email, a device id or a printer name.
 *
 * Every dependency arrives as an argument — the clock, the transport, the store —
 * so the orchestration can be exercised without a broker and without a database.
 */

import { accept, emptyCoordinatorState, snapshotsFor } from "../../bridge/src/coordinator/merge.ts";
import { buildWebhookPayload } from "../../bridge/src/push/payload.ts";
import { hostsFor, CLOUD_MQTT_PORT } from "../../bridge/src/providers/bambu-cloud/hosts.ts";
import { watchCloudMqtt } from "../../bridge/src/providers/cloud-mqtt.ts";
import {
  systemTimers,
  type ByteStream,
  type SessionEnd,
  type Timers,
} from "../../bridge/src/mqtt/client.ts";
import type { CoordinatorState } from "../../bridge/src/coordinator/merge.ts";
import type { Observation } from "../../bridge/src/types.ts";
import type { Account, Store } from "../../hosted/src/store.ts";

const UTF8 = new TextEncoder();

/**
 * How long a report is allowed to sit before it becomes a render.
 *
 * A printing X1 reports every second or two. Rendering each one would write to
 * Postgres at that rate for no visible gain, because TRMNL fetches every fifteen
 * minutes. Coalescing to one write every few seconds keeps the stored screen
 * fresh enough that the cron always stands aside, at a write rate the database
 * will not notice.
 */
export const RENDER_COALESCE_MS = 5_000;

export interface SessionPorts {
  store: Store;
  /** Opens a byte stream to a host and port. Node TLS in production. */
  connect(target: { host: string; port: number }): Promise<ByteStream>;
  /** The MQTT username for this account, `u_<uid>`. */
  username: string;
  /** Opened from the sealed token by the caller, so this module never decrypts. */
  accessToken: string;
  clientId: string;
  now(): number;
  /**
   * Resolves when this session must end.
   *
   * Required, not optional. A session that cannot be stopped is the failure the
   * lease exists to prevent: when the lease is lost the lock has already gone,
   * so a standby is free to open its own sessions, and an old process still
   * holding its own would put two MQTT connections on one Bambu account and two
   * writers on one screen row. Bambu bans accounts for the first.
   */
  stopped: Promise<void>;
  /**
   * What HTTP already knows, applied before the first report arrives.
   *
   * Required, because MQTT does not carry a printer's name. It carries metrics
   * and a state token and nothing that says which machine this is, so a session
   * built from reports alone renders a nameless card — and "an idle printer
   * shows its name" is the product's one promise about the idle case. HTTP is
   * the baseline and MQTT is the enrichment, in that order, exactly as the
   * self-hosted bridge does it.
   */
  baseline: readonly Observation[];
  /** Defaults to the runtime clock; injected to make delayed coalescing deterministic. */
  timers?: Pick<Timers, "once">;
  /** Called after each stored render, for logging that names no printer. */
  onRender?(detail: { bytes: number; printers: number }): void;
}

/**
 * Holds one session until the broker ends it, rendering as reports arrive.
 *
 * Resolves with how the session ended, so the caller owns the decision to
 * reconnect. That decision does not belong here: Bambu has banned accounts over
 * reconnect storms, and backoff needs the whole picture.
 */
export async function runAccountSession(
  account: Account,
  ports: SessionPorts,
): Promise<SessionEnd> {
  const hosts = hostsFor(account.region);
  const stream = await ports.connect({ host: hosts.mqtt, port: CLOUD_MQTT_PORT });

  // The coordinator persists across reports for the life of this session, which
  // is the whole reason a held connection is worth having: a P1 sends only the
  // fields that changed, so the accumulated view is richer than any one report.
  //
  // It starts from what HTTP said rather than from nothing, so a name and an
  // online flag are present from the first render and survive every report that
  // does not mention them. The coordinator's own provider precedence decides the
  // rest: MQTT wins for the fields it carries, HTTP keeps the ones it does not.
  let coordinator = emptyCoordinatorState();
  for (const observation of ports.baseline) {
    coordinator = accept(coordinator, observation);
  }
  let pending = false;
  let writing: Promise<void> | null = null;
  let cancelDelayedRender: (() => void) | null = null;
  let lastRenderAt = 0;
  const timers = ports.timers ?? systemTimers;

  function cancelScheduledRender(): void {
    if (cancelDelayedRender === null) return;
    cancelDelayedRender();
    cancelDelayedRender = null;
  }
  /**
   * Set once this session must stop.
   *
   * No write *begins* after it. A write already awaiting when the halt arrives
   * still completes, because nothing here can cancel a query in flight, so the
   * bound is at most one further row — not zero.
   */
  let halted = false;

  const render = async (): Promise<void> => {
    pending = false;
    const now = ports.now();
    lastRenderAt = now;
    const snapshots = snapshotsFor(coordinator, account.deviceIds, now);
    const payload = buildWebhookPayload(snapshots, {
      now,
      // The session being open is itself the evidence the cloud is reachable.
      cloud: "connected",
      maxBytes: account.maxPayloadBytes,
      exportJobName: account.exportJobName,
    });

    // Merge variables at the root and nulls dropped, matching what the cron
    // writes, because `GET /v1/screen` serves whichever of us wrote last and
    // TRMNL must not see two different shapes.
    const body = JSON.stringify(payload.variables, (_key, value: unknown) =>
      value === null ? undefined : value,
    );
    if (body === undefined) return;
    const bytes = UTF8.encode(body).byteLength;
    // A payload over the account's ceiling is not written at all. Replacing a
    // good render with one TRMNL will refuse would be worse than keeping the
    // older one, which the endpoint already reports the age of.
    if (bytes > account.maxPayloadBytes) return;

    // Checked again here, and not only on entry: this is the last instant before
    // the row is written, and everything above it was awaited. A halt that
    // arrived meanwhile means a standby owns this row now.
    if (halted) return;
    await ports.store.writeScreen(account.id, { body, renderedAt: now });
    ports.onRender?.({ bytes, printers: snapshots.length });
  };

  const beginRender = (): void => {
    if (halted || writing !== null) return;
    cancelScheduledRender();
    writing = render()
      .catch(() => {
        // A failed write is not a reason to drop the session. The next report is
        // seconds away, and the endpoint keeps serving the previous render.
      })
      .finally(() => {
        writing = null;
        if (pending) scheduleRender();
      });
  };

  /** Coalesces a burst into one write and guarantees the final state a deadline. */
  const scheduleRender = (): void => {
    if (halted) return;
    if (writing !== null) {
      pending = true;
      return;
    }
    const remaining = RENDER_COALESCE_MS - (ports.now() - lastRenderAt);
    if (remaining > 0) {
      pending = true;
      if (cancelDelayedRender === null) {
        cancelDelayedRender = timers.once(remaining, () => {
          cancelDelayedRender = null;
          if (!halted && pending) beginRender();
        });
      }
      return;
    }
    beginRender();
  };

  // Arm the write fence before the baseline render. The stop signal can already
  // be resolved when this function is entered, and even that case must not begin
  // a database write for a lease this process no longer owns.
  void ports.stopped.then(() => {
    halted = true;
    pending = false;
    cancelScheduledRender();
  });
  // Promise reactions run on a microtask. Yield once so an already-resolved
  // stop signal closes the fence before the synchronous part of `render` can
  // begin a baseline write.
  await Promise.resolve();

  // Write what HTTP already knows, before waiting on a single report. An idle
  // account may not produce an MQTT report for hours, and until one arrives this
  // render is the only thing standing between the display and a stale screen the
  // cron is no longer allowed to refresh.
  if (ports.baseline.length > 0) {
    await render().catch(() => {
      // The session is still worth having if this one write failed; the next
      // report will try again.
    });
  }

  const { end, stop } = watchCloudMqtt(stream, {
    username: ports.username,
    accessToken: ports.accessToken,
    deviceIds: account.deviceIds,
    exportJobName: account.exportJobName,
    clientId: ports.clientId,
    clock: ports.now,
    onObservation: (observation: Observation) => {
      if (halted) return;
      coordinator = accept(coordinator, observation);
      scheduleRender();
    },
  });

  // Closing the connection is what actually ends this session; the flag is what
  // stops a write already in flight from landing after the lease is gone. Both
  // are needed, because a healthy broker never ends a session on its own and the
  // process that has lost its lease must stop writing rows a standby now owns.
  void ports.stopped.then(() => {
    void stop();
  });

  const ending = await end;
  // Flush whatever the last reports established, so a session that ends after a
  // burst does not discard the newest state. Not after a halt: those rows belong
  // to whoever holds the lease now.
  if (!halted && (pending || writing !== null)) {
    cancelScheduledRender();
    await writing;
    // A completed write can schedule the delayed follow-up from its `finally`.
    // Cancel that timer too before flushing immediately on the ordinary end.
    cancelScheduledRender();
    if (pending) await render().catch(() => undefined);
  }
  return ending;
}

/** Exposed for tests that need to assert on accumulated state. */
export type { CoordinatorState };

/**
 * The collector's orchestration, separated from the process it runs in.
 *
 * Everything here is a decision — take the lease or wait for it, collect or
 * refuse, keep the lease or give it up — and every one of those decisions was
 * previously reachable only by starting a real process against a real database.
 * That is how a session which could not be stopped survived review: the code
 * that would have shown it had no test, because it could not be called.
 *
 * So `index.ts` reads the environment and builds real ports, and this module
 * decides what happens. It touches no global: no `process`, no clock, no signal.
 */

import type { LeaseConnection, LeaseOptions, LeaseResult } from "./lease.ts";
import { collectAll, type CollectorPorts } from "./run.ts";

/** `EX_CONFIG` from sysexits: a restart cannot fix this, so do not restart. */
export const EX_CONFIG = 78;

/**
 * A lost lease is a failure, not a clean stop.
 *
 * It has to be, because the documented restart policy is `on-failure`: exiting
 * zero here would leave the container stopped, and the collector's whole reason
 * for existing gone until somebody noticed.
 */
export const EX_LEASE_LOST = 1;

export interface SuperviseOptions {
  /** Names this instance in local logs. Never a secret. */
  instance: string;
  maxAccounts: number;
  /** How long a standby waits before asking for the lease again. */
  standbyPollMs: number;
  /** How long before the account set is read again. */
  rediscoverMs: number;
}

export interface SupervisePorts extends CollectorPorts {
  /** Opens one real Postgres session for the lease. */
  leaseConnect(): Promise<LeaseConnection>;
  takeLease(
    connect: () => Promise<LeaseConnection>,
    options: LeaseOptions,
  ): Promise<LeaseResult>;
  /** Heartbeat interval handed to the lease. */
  heartbeatMs: number;
  /** Called when the lease is lost, so the process can wind its sessions down. */
  onLeaseLost(reason: string): void;
}

/**
 * Runs the collector until it is stopped, and returns the exit status.
 *
 * The order matters and is the whole contract: prove the database can enforce a
 * lease, hold the lease, and only then collect. Nothing reads an account before
 * the lease is held, and nothing keeps collecting once it is lost.
 */
export async function supervise(
  ports: SupervisePorts,
  options: SuperviseOptions,
): Promise<number> {
  let lostReason: string | null = null;

  const leaseOptions: LeaseOptions = {
    instanceId: options.instance,
    heartbeatMs: ports.heartbeatMs,
    now: ports.now,
    onLost: (reason) => {
      // Collecting without the lease is the one thing this process must never
      // do. By the time the heartbeat notices, the lock is already gone and a
      // standby may hold it, so the live sessions have to close — not merely be
      // marked — or two MQTT connections end up on one Bambu account.
      lostReason = reason;
      ports.log("error", "lost the collection lease", { reason });
      ports.onLeaseLost(reason);
    },
  };

  // A standby waits rather than exiting, which is what makes a zero-gap restart
  // just "start the new one, then stop the old one": the new process is already
  // asking, and Postgres frees the lock the moment the old connection drops.
  // Exiting instead would put the retry cadence in the supervisor, where the
  // documented `on-failure` policy would never restart a cleanly-exited standby.
  let lease = await ports.takeLease(ports.leaseConnect, leaseOptions);
  let announced = false;
  while (lease.kind === "taken" && !ports.stopping()) {
    if (!announced) {
      // Said once. A line every few seconds would bury the moment it takes over.
      ports.log("info", "another collector holds the lease", {
        instance: options.instance,
      });
      announced = true;
    }
    await ports.sleep(options.standbyPollMs);
    if (ports.stopping()) break;
    lease = await ports.takeLease(ports.leaseConnect, leaseOptions);
  }

  if (lease.kind === "unusable") {
    ports.log("error", "this database cannot enforce the collection lease", {
      reason: lease.reason,
      guidance: lease.guidance,
    });
    return EX_CONFIG;
  }
  if (lease.kind !== "held") {
    // Signalled while waiting its turn. Nothing was collected, and there is no
    // lease to give back.
    return 0;
  }

  ports.log("info", "holding the collection lease", { instance: options.instance });

  try {
    // `collectAll` returns when every account it started has finished, which
    // happens on a fresh deployment with nobody enrolled and again once the
    // cloud has refused everyone. Exiting there would be wrong twice over: a
    // container that exits zero is not restarted by an `on-failure` policy, so
    // the next person to enrol would get no live telemetry until somebody
    // noticed. So the process keeps the lease and looks again.
    while (!ports.stopping()) {
      await collectAll(ports, { maxAccounts: options.maxAccounts });
      if (ports.stopping()) break;
      // A new enrolment waits at most this long for live telemetry, and the
      // cron already covers it at HTTP fidelity in the meantime.
      await ports.sleep(options.rediscoverMs);
    }
  } finally {
    await lease.release().catch(() => {
      // Failing to give the lock back on the way out is harmless: Postgres frees
      // it when the connection drops, which is what is happening.
    });
  }

  // Reported as a failure so the documented `on-failure` policy restarts it. A
  // clean exit here would leave the container stopped with nothing collecting.
  return lostReason === null ? 0 : EX_LEASE_LOST;
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { healthFrom, pollCloudHttp } from "../src/providers/cloud-http.ts";
import { hostsFor } from "../src/providers/bambu-cloud/hosts.ts";
import { DEVICE_ID } from "./synthetic-values.ts";

const HOSTS = hostsFor("global");
const TOKEN = `t${"o".repeat(20)}ken`;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const OTHER_DEVICE = `${DEVICE_ID}B`;

const BIND_BODY = {
  devices: [
    {
      dev_id: DEVICE_ID,
      name: "Workshop printer",
      dev_model_name: "Synthetic model",
      online: true,
      print_status: "RUNNING",
    },
    { dev_id: OTHER_DEVICE, name: "Someone else's printer", online: true },
  ],
};

const PRINT_BODY = {
  devices: [{ dev_id: DEVICE_ID, dev_online: true, task_status: "RUNNING", progress: 42 }],
};

/**
 * Answers the two endpoints from a routing table. A route may be a body, or a
 * status number to fail with.
 */
function stubCloud(routes: { bind: unknown; print: unknown }): void {
  vi.stubGlobal("fetch", (input: string) => {
    const route = input.includes("/user/bind") ? routes.bind : routes.print;
    if (typeof route === "number") {
      return Promise.resolve(new Response("refused", { status: route }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(route), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  });
}

function poll(deviceIds: readonly string[] = [DEVICE_ID]) {
  return pollCloudHttp({
    hosts: HOSTS,
    accessToken: TOKEN,
    deviceIds,
    exportJobName: false,
    now: NOW,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollCloudHttp", () => {
  it("observes only the printers the user chose", async () => {
    stubCloud({ bind: BIND_BODY, print: PRINT_BODY });
    const result = await poll();

    expect(result.status).toBe("connected");
    expect(result.errorCategory).toBeNull();
    expect(new Set(result.observations.map((entry) => entry.printerKey))).toEqual(
      new Set([DEVICE_ID]),
    );
  });

  it("attributes every observation to the HTTP read path and the bridge clock", async () => {
    stubCloud({ bind: BIND_BODY, print: PRINT_BODY });
    for (const observation of (await poll()).observations) {
      expect(observation.providerId).toBe("cloud-http");
      expect(observation.receivedAt).toBe(NOW);
      // The cloud sends no observation time on these endpoints, and inventing
      // one would make the staleness window a lie.
      expect(observation.observedAt).toBeNull();
    }
  });

  it("reports honestly that HTTP knows nothing about layers or temperatures", async () => {
    stubCloud({ bind: BIND_BODY, print: PRINT_BODY });
    const result = await poll();

    for (const observation of result.observations) {
      expect(observation.fields).not.toHaveProperty("temperatures");
      expect(observation.fields.job).not.toHaveProperty("layer");
      expect(observation.fields.job).not.toHaveProperty("remainingMinutes");
      expect(observation.capabilities.temperatures).toBe(false);
      expect(observation.capabilities.realtimeTelemetry).toBe(false);
    }
  });

  // Half a picture beats none: knowing a printer is online is worth showing
  // even when the current-job endpoint is unavailable.
  it("keeps what one endpoint said when the other fails", async () => {
    stubCloud({ bind: BIND_BODY, print: 500 });
    const result = await poll();

    expect(result.status).toBe("connected");
    expect(result.errorCategory).toBe("server-error");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.fields.printer?.online).toBe(true);
  });

  // An expired token is not a transport fault. Retrying it in a loop is how a
  // bridge hammers a service and never tells its owner to sign in again.
  it("asks for reauthentication rather than reporting a disconnection", async () => {
    stubCloud({ bind: 401, print: 401 });
    const result = await poll();

    expect(result.status).toBe("reauth_required");
    expect(result.errorCategory).toBe("unauthorized-or-expired");
    expect(result.observations).toEqual([]);
  });

  it("reports a total failure as a disconnection", async () => {
    stubCloud({ bind: 500, print: 500 });
    expect((await poll()).status).toBe("disconnected");
  });

  it("survives a response whose shape has drifted", async () => {
    stubCloud({ bind: { devices: "not-an-array" }, print: { unexpected: true } });
    const result = await poll();

    expect(result.status).toBe("connected");
    expect(result.observations).toEqual([]);
  });

  it("never lets an error carry more than a category", async () => {
    stubCloud({ bind: 403, print: 403 });
    const result = await poll();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("healthFrom", () => {
  it("records an observation time only when something was observed", async () => {
    stubCloud({ bind: BIND_BODY, print: PRINT_BODY });
    expect(healthFrom(await poll(), NOW)).toEqual({
      id: "cloud-http",
      status: "connected",
      lastObservationAt: NOW,
      lastErrorCategory: null,
    });

    stubCloud({ bind: 500, print: 500 });
    expect(healthFrom(await poll(), NOW)).toEqual({
      id: "cloud-http",
      status: "disconnected",
      lastObservationAt: null,
      lastErrorCategory: "server-error",
    });
  });
});

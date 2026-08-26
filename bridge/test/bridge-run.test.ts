import { describe, expect, it } from "vitest";
import {
  runBridge,
  type RunDependencies,
} from "../src/bridge/run.ts";
import type { Logger } from "../src/bridge/log.ts";
import type {
  ByteStream,
  SessionEnd,
} from "@trmnl-bambulab/core/telemetry/mqtt/client";
import type { BridgeConfig } from "../src/setup/config.ts";

const DEVICE_ID = `${"0".repeat(12)}A1`;
const TOKEN_PAYLOAD = Buffer.from(JSON.stringify({ username: "u_1234567" })).toString(
  "base64url",
);

function config(): BridgeConfig {
  return {
    cloud: {
      region: "global",
      accessToken: `header.${TOKEN_PAYLOAD}.signature`,
      accountHint: null,
      deviceIds: [DEVICE_ID],
    },
    trmnl: {
      webhookUrl: "https://trmnl.example.test/webhook",
      maxPushesPerHour: 12,
      maxPayloadBytes: 2048,
      exportJobName: false,
    },
    logLevel: "error",
  };
}

function logger(onDebug?: (message: string) => void): Logger {
  return {
    debug: (message) => onDebug?.(message),
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

class OpenStream implements ByteStream {
  closes = 0;

  async *read(): AsyncIterable<Buffer> {
    await new Promise<void>(() => undefined);
  }

  async write(): Promise<void> {}

  async close(): Promise<void> {
    this.closes += 1;
  }
}

function connectedPoll() {
  return {
    observations: [],
    status: "connected" as const,
    errorCategory: null,
  };
}

describe("bridge shutdown", () => {
  it("stops the live MQTT session and settles after graceful shutdown", async () => {
    const shutdown = Promise.withResolvers<void>();
    const subscribed = Promise.withResolvers<void>();
    const ending = Promise.withResolvers<SessionEnd>();
    const stream = new OpenStream();
    let stops = 0;

    const dependencies: RunDependencies = {
      now: () => 1_000_000,
      openMqttStream: async () => stream,
      watchMqtt: (opened, options) => {
        options.onSubscribed?.();
        subscribed.resolve();
        return {
          end: ending.promise,
          stop: async () => {
            stops += 1;
            await opened.close();
            ending.resolve({ reason: "closed-by-caller" });
          },
        };
      },
      pollCloud: async () => {
        await subscribed.promise;
        shutdown.resolve();
        return connectedPoll();
      },
      push: async () => ({ ok: true, status: 200 }),
    };

    await runBridge({ config: config(), logger: logger(), until: shutdown.promise }, dependencies);

    expect(stops).toBe(1);
    expect(stream.closes).toBe(1);
  });

  it("does not wait out a reconnect delay after shutdown", async () => {
    const shutdown = Promise.withResolvers<void>();
    let attempts = 0;
    const dependencies: RunDependencies = {
      now: () => 1_000_000,
      openMqttStream: async () => {
        attempts += 1;
        throw new Error("synthetic connection failure");
      },
      watchMqtt: () => {
        throw new Error("no session should be created");
      },
      pollCloud: async () => connectedPoll(),
      push: async () => ({ ok: true, status: 200 }),
    };
    const testLogger = logger((message) => {
      if (message === "waiting before reconnecting") shutdown.resolve();
    });

    await runBridge({ config: config(), logger: testLogger, until: shutdown.promise }, dependencies);

    expect(attempts).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  canPush,
  configFromEnv,
  parseEnv,
  patchEnv,
  serializeEnv,
  summarizeConfig,
  validateConfig,
  type BridgeConfig,
} from "../src/setup/config.ts";
import { DEVICE_ID, secondsFrom, syntheticToken, syntheticWebhookUrl } from "./synthetic-values.ts";

const NOW = Date.UTC(2026, 0, 1);
const TOKEN = syntheticToken({ username: "u_1234567", exp: secondsFrom(NOW, 30 * 86_400_000) });
const WEBHOOK = syntheticWebhookUrl();
const SECOND_DEVICE = `${DEVICE_ID}B`;

function cloud(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    region: "global",
    accessToken: TOKEN,
    accountHint: "p•••@example.com",
    deviceIds: [DEVICE_ID],
    ...overrides,
  };
}

function trmnl(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { webhookUrl: WEBHOOK, ...overrides };
}

function accept(value: unknown): BridgeConfig {
  const result = validateConfig(value);
  if (!result.ok) {
    throw new Error(`expected a valid config, got: ${JSON.stringify(result.problems)}`);
  }
  return result.config;
}

function reject(value: unknown): { path: string; message: string; guidance: string }[] {
  const result = validateConfig(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  for (const problem of result.problems) expect(problem.guidance.length).toBeGreaterThan(0);
  return result.problems;
}

describe("validateConfig — shape", () => {
  it("accepts a cloud account plus a webhook and fills defaults", () => {
    const config = accept({ cloud: cloud(), trmnl: trmnl() });
    expect(config.trmnl.maxPushesPerHour).toBe(12);
    expect(config.trmnl.maxPayloadBytes).toBe(2048);
    expect(config.trmnl.exportJobName).toBe(false);
    expect(config.logLevel).toBe("info");
  });

  it("requires a cloud account, because there is no other data source", () => {
    const problems = reject({ trmnl: trmnl() });
    expect(problems.some((problem) => problem.path === "cloud")).toBe(true);
  });

  it("requires at least one chosen printer", () => {
    const problems = reject({ cloud: cloud({ deviceIds: [] }), trmnl: trmnl() });
    expect(problems[0]?.path).toBe("cloud.deviceIds");
  });

  it("accepts several printers", () => {
    const config = accept({
      cloud: cloud({ deviceIds: [DEVICE_ID, SECOND_DEVICE] }),
      trmnl: trmnl(),
    });
    expect(config.cloud.deviceIds).toHaveLength(2);
  });
});

describe("validateConfig — cloud fields", () => {
  // An opaque token is a token. Guessing at the format and refusing one the
  // cloud just issued would be worse than not checking. See docs/DECISIONS.md D9.
  it("accepts an opaque token that is not JWT-shaped", () => {
    const config = accept({ cloud: cloud({ accessToken: "an-opaque-token" }), trmnl: trmnl() });
    expect(config.cloud.accessToken).toBe("an-opaque-token");
  });

  it("rejects a token containing whitespace, which only ever means a bad paste", () => {
    const problems = reject({ cloud: cloud({ accessToken: "two words" }), trmnl: trmnl() });
    expect(problems[0]?.path).toBe("cloud.accessToken");
  });

  it("rejects an empty token", () => {
    const problems = reject({ cloud: cloud({ accessToken: "" }), trmnl: trmnl() });
    expect(problems[0]?.path).toBe("cloud.accessToken");
  });

  it("rejects an unknown region", () => {
    const problems = reject({ cloud: cloud({ region: "mars" }), trmnl: trmnl() });
    expect(problems[0]?.path).toBe("cloud.region");
  });

  it("refuses to store a raw account email", () => {
    const problems = reject({
      cloud: cloud({ accountHint: "person@example.com" }),
      trmnl: trmnl(),
    });
    expect(problems[0]?.path).toBe("cloud.accountHint");
  });

  it("allows no account hint at all", () => {
    const config = accept({ cloud: cloud({ accountHint: null }), trmnl: trmnl() });
    expect(config.cloud.accountHint).toBeNull();
  });
});

describe("validateConfig — TRMNL", () => {
  it("rejects a webhook URL that is not a TRMNL webhook", () => {
    const problems = reject({
      cloud: cloud(),
      trmnl: trmnl({ webhookUrl: "https://example.com/hook" }),
    });
    expect(problems[0]?.path).toBe("trmnl.webhookUrl");
  });

  it("accepts a missing webhook URL so setup can finish without one", () => {
    const config = accept({ cloud: cloud(), trmnl: trmnl({ webhookUrl: null }) });
    expect(config.trmnl.webhookUrl).toBeNull();
    expect(canPush(config)).toBe(false);
  });

  it("reports that a configured webhook can push", () => {
    expect(canPush(accept({ cloud: cloud(), trmnl: trmnl() }))).toBe(true);
  });

  it("keeps the push and size ceilings inside the account limits", () => {
    expect(
      reject({ cloud: cloud(), trmnl: trmnl({ maxPushesPerHour: 31 }) })[0]?.path,
    ).toBe("trmnl.maxPushesPerHour");
    expect(reject({ cloud: cloud(), trmnl: trmnl({ maxPayloadBytes: 10_000 }) })[0]?.path).toBe(
      "trmnl.maxPayloadBytes",
    );
  });

  it("accepts the TRMNL+ ceilings", () => {
    const config = accept({
      cloud: cloud(),
      trmnl: trmnl({ maxPushesPerHour: 30, maxPayloadBytes: 5120 }),
    });
    expect(config.trmnl.maxPushesPerHour).toBe(30);
  });
});

describe("parseEnv", () => {
  it("ignores comments and blank lines", () => {
    expect(parseEnv("# note\n\nA=1\n")).toEqual({ A: "1" });
  });

  it("strips one layer of matching quotes", () => {
    expect(parseEnv(`A="one"\nB='two'\nC="mixed'\n`)).toEqual({
      A: "one",
      B: "two",
      C: `"mixed'`,
    });
  });

  it("splits on the first separator only", () => {
    expect(parseEnv("A=one=two\n")).toEqual({ A: "one=two" });
  });

  it("skips a line with no key", () => {
    expect(parseEnv("=orphan\n")).toEqual({});
  });
});

describe("configFromEnv", () => {
  const base: Record<string, string> = {
    BAMBU_CLOUD_REGION: "global",
    BAMBU_CLOUD_ACCESS_TOKEN: TOKEN,
    BAMBU_CLOUD_ACCOUNT_HINT: "p•••@example.com",
    BAMBU_CLOUD_DEVICE_IDS: DEVICE_ID,
    TRMNL_WEBHOOK_URL: WEBHOOK,
  };

  it("builds a config and applies defaults", () => {
    const result = configFromEnv(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.cloud.deviceIds).toEqual([DEVICE_ID]);
    expect(result.config.trmnl.maxPushesPerHour).toBe(12);
  });

  it("splits a comma-separated printer list and drops blanks", () => {
    const result = configFromEnv({
      ...base,
      BAMBU_CLOUD_DEVICE_IDS: `${DEVICE_ID}, ,${SECOND_DEVICE},`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.cloud.deviceIds).toEqual([DEVICE_ID, SECOND_DEVICE]);
  });

  it("treats an empty webhook value as absent rather than invalid", () => {
    const result = configFromEnv({ ...base, TRMNL_WEBHOOK_URL: "  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.trmnl.webhookUrl).toBeNull();
  });

  it("coerces booleans and numbers", () => {
    const result = configFromEnv({
      ...base,
      TRMNL_MAX_PUSHES_PER_HOUR: "30",
      TRMNL_EXPORT_JOB_NAME: "TRUE",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.trmnl.maxPushesPerHour).toBe(30);
    expect(result.config.trmnl.exportJobName).toBe(true);
  });

  it("reports an unparseable number against its own field", () => {
    const result = configFromEnv({ ...base, TRMNL_MAX_PUSHES_PER_HOUR: "many" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.path).toBe("trmnl.maxPushesPerHour");
  });

  it("reports an unparseable boolean against its own field", () => {
    const result = configFromEnv({ ...base, TRMNL_EXPORT_JOB_NAME: "yes please" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.path).toBe("trmnl.exportJobName");
  });
});

describe("serializeEnv", () => {
  const config = accept({
    cloud: cloud({ deviceIds: [DEVICE_ID, SECOND_DEVICE] }),
    trmnl: trmnl(),
  });

  it("round-trips through the file format", () => {
    const round = configFromEnv(parseEnv(serializeEnv(config)));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.config).toEqual(config);
  });

  it("round-trips a config with no webhook yet", () => {
    const pending = accept({ cloud: cloud(), trmnl: trmnl({ webhookUrl: null }) });
    const round = configFromEnv(parseEnv(serializeEnv(pending)));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.config.trmnl.webhookUrl).toBeNull();
  });

  it("ends in exactly one newline and carries a warning header", () => {
    const text = serializeEnv(config);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).toContain("git-ignored");
  });

  it("never writes a password field", () => {
    expect(serializeEnv(config).toLowerCase()).not.toContain("password");
  });
});

describe("patchEnv", () => {
  it("rewrites only the named keys and keeps everything else byte-identical", () => {
    const before = "# head\nA=1\nB=2\n";
    expect(patchEnv(before, { B: "3" })).toBe("# head\nA=1\nB=3\n");
  });

  it("appends a key the file did not have", () => {
    expect(patchEnv("A=1\n", { C: "3" })).toContain("C=3");
  });

  it("leaves a commented-out key alone", () => {
    expect(patchEnv("# A=1\n", { A: "2" })).toContain("# A=1");
  });

  // `reauth` patches a freshly issued token in without re-running the schema,
  // so a mangled value must fail loudly rather than become an extra line.
  it("refuses a value containing a line break", () => {
    expect(() => patchEnv("A=1\n", { A: "one\ntwo" })).toThrow(/line break/);
    expect(() => patchEnv("A=1\n", { A: "one\r\ntwo" })).toThrow(/line break/);
  });
});

describe("summarizeConfig", () => {
  it("masks every secret and identifier", () => {
    const text = summarizeConfig(accept({ cloud: cloud(), trmnl: trmnl() })).join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(DEVICE_ID);
    expect(text).not.toContain(WEBHOOK);
  });

  it("says when the webhook has not been set yet", () => {
    const text = summarizeConfig(
      accept({ cloud: cloud(), trmnl: trmnl({ webhookUrl: null }) }),
    ).join("\n");
    expect(text).toContain("pnpm setup webhook");
  });
});

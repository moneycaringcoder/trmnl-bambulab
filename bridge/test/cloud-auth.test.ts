import { describe, expect, it } from "vitest";
import {
  LOGIN_PATH,
  SEND_EMAIL_CODE_PATH,
  TFA_PATH,
  advance,
  beginPasswordLogin,
  type AuthPhase,
  type AuthTransition,
} from "../src/providers/bambu-cloud/auth.ts";
import { syntheticToken } from "./synthetic-values.ts";

const ACCOUNT = "printer-owner@example.com";
// Built at runtime so no password-shaped literal exists in this file.
const PASSWORD = "x".repeat(10);
const TOKEN = syntheticToken({ username: "u_1234567" });

function expectFailure(transition: AuthTransition): {
  code: string;
  message: string;
  guidance: string;
} {
  expect(transition.phase.kind).toBe("failed");
  if (transition.phase.kind !== "failed") throw new Error("unreachable");
  expect(transition.request).toBeNull();
  expect(transition.prompt).toBeNull();
  expect(transition.phase.failure.guidance.length).toBeGreaterThan(0);
  return transition.phase.failure;
}

describe("beginPasswordLogin", () => {
  it("asks for one login POST and keeps the password out of the phase", () => {
    const transition = beginPasswordLogin(ACCOUNT, PASSWORD);
    expect(transition.phase).toEqual({ kind: "await-login-result", account: ACCOUNT });
    expect(transition.request).toEqual({
      path: LOGIN_PATH,
      body: { account: ACCOUNT, password: PASSWORD, apiError: "" },
    });
    expect(JSON.stringify(transition.phase)).not.toContain(PASSWORD);
    expect(transition.prompt).toBeNull();
  });
});

describe("password-only branch", () => {
  it("finishes as soon as a token arrives", () => {
    const start = beginPasswordLogin(ACCOUNT, PASSWORD);
    const next = advance(start.phase, { kind: "login-result", response: { accessToken: TOKEN } });
    expect(next.phase).toEqual({ kind: "authenticated", accessToken: TOKEN });
    expect(next.request).toBeNull();
    expect(next.prompt).toBeNull();
  });

  it("treats an empty token string as no token", () => {
    const start = beginPasswordLogin(ACCOUNT, PASSWORD);
    const failure = expectFailure(
      advance(start.phase, { kind: "login-result", response: { accessToken: "" } }),
    );
    expect(failure.code).toBe("unknown-login-type");
  });
});

describe("verification-code branch", () => {
  it("sends the code email, prompts, then logs in with the code", () => {
    const start = beginPasswordLogin(ACCOUNT, PASSWORD);
    const asked = advance(start.phase, {
      kind: "login-result",
      response: { loginType: "verifyCode" },
    });

    expect(asked.phase).toEqual({ kind: "await-email-code", account: ACCOUNT });
    expect(asked.request).toEqual({
      path: SEND_EMAIL_CODE_PATH,
      body: { email: ACCOUNT, type: "codeLogin" },
    });
    expect(asked.prompt?.field).toBe("email-code");

    const submitted = advance(asked.phase, { kind: "email-code", code: "123456" });
    expect(submitted.phase).toEqual({ kind: "await-code-login-result", account: ACCOUNT });
    expect(submitted.request).toEqual({
      path: LOGIN_PATH,
      body: { account: ACCOUNT, code: "123456" },
    });

    const done = advance(submitted.phase, {
      kind: "login-result",
      response: { accessToken: TOKEN },
    });
    expect(done.phase).toEqual({ kind: "authenticated", accessToken: TOKEN });
  });

  it("reports a rejected code instead of prompting again", () => {
    const phase: AuthPhase = { kind: "await-code-login-result", account: ACCOUNT };
    const failure = expectFailure(
      advance(phase, { kind: "login-result", response: { loginType: "verifyCode" } }),
    );
    expect(failure.code).toBe("code-rejected");
    expect(failure.guidance).toMatch(/pnpm setup/);
  });
});

describe("two-factor branch", () => {
  it("prompts for the code and posts it with the tfaKey", () => {
    const start = beginPasswordLogin(ACCOUNT, PASSWORD);
    const asked = advance(start.phase, {
      kind: "login-result",
      response: { loginType: "tfa", tfaKey: "key-1" },
    });
    expect(asked.phase).toEqual({ kind: "await-tfa-code", tfaKey: "key-1" });
    expect(asked.request).toBeNull();
    expect(asked.prompt?.field).toBe("tfa-code");

    const submitted = advance(asked.phase, { kind: "tfa-code", code: "654321" });
    expect(submitted.phase).toEqual({ kind: "await-tfa-result" });
    expect(submitted.request).toEqual({
      path: TFA_PATH,
      body: { tfaKey: "key-1", tfaCode: "654321" },
    });

    const done = advance(submitted.phase, {
      kind: "login-result",
      response: { accessToken: TOKEN },
    });
    expect(done.phase).toEqual({ kind: "authenticated", accessToken: TOKEN });
  });

  it("fails when the cloud asks for two-factor without a key", () => {
    const start = beginPasswordLogin(ACCOUNT, PASSWORD);
    const failure = expectFailure(
      advance(start.phase, { kind: "login-result", response: { loginType: "tfa" } }),
    );
    expect(failure.code).toBe("missing-tfa-key");
  });

  it("fails when the two-factor step returns no token", () => {
    const failure = expectFailure(
      advance({ kind: "await-tfa-result" }, { kind: "login-result", response: {} }),
    );
    expect(failure.code).toBe("no-token");
  });
});

describe("unknown and out-of-order steps", () => {
  it("names an unrecognized login type without inventing a branch", () => {
    const start = beginPasswordLogin(ACCOUNT, PASSWORD);
    const failure = expectFailure(
      advance(start.phase, { kind: "login-result", response: { loginType: "captcha" } }),
    );
    expect(failure.code).toBe("unknown-login-type");
    expect(failure.message).toContain("captcha");
  });

  it("refuses to advance from a settled phase", () => {
    expect(
      expectFailure(
        advance({ kind: "authenticated", accessToken: TOKEN }, {
          kind: "login-result",
          response: { accessToken: TOKEN },
        }),
      ).code,
    ).toBe("unexpected-event");

    const settled: AuthPhase = {
      kind: "failed",
      failure: { code: "no-token", message: "m", guidance: "g" },
    };
    expect(expectFailure(advance(settled, { kind: "tfa-code", code: "1" })).code).toBe(
      "unexpected-event",
    );
  });

  it("refuses a code event in a phase that is waiting for a response", () => {
    const failure = expectFailure(
      advance({ kind: "await-login-result", account: ACCOUNT }, { kind: "email-code", code: "1" }),
    );
    expect(failure.code).toBe("unexpected-event");
  });
});

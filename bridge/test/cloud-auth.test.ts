import { describe, expect, it } from "vitest";
import {
  LOGIN_PATH,
  SEND_EMAIL_CODE_PATH,
  advance,
  beginCodeLogin,
  beginPasswordLogin,
  type AuthPhase,
  type AuthTransition,
} from "../src/providers/bambu-cloud/auth.ts";
import { MQTT_USERNAME, syntheticToken } from "./synthetic-values.ts";

const ACCOUNT = "printer-owner@example.com";
// Built at runtime so no password-shaped literal exists in this file.
const PASSWORD = "x".repeat(10);
const TOKEN = syntheticToken({ username: MQTT_USERNAME });

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

describe("beginCodeLogin", () => {
  it("asks Bambu to email a code without ever taking a password", () => {
    const transition = beginCodeLogin(ACCOUNT);

    expect(transition.phase).toEqual({ kind: "await-email-code", account: ACCOUNT });
    expect(transition.request).toEqual({
      path: SEND_EMAIL_CODE_PATH,
      body: { email: ACCOUNT, type: "codeLogin" },
    });
    // The hosted tier uses this path precisely so a Bambu password never
    // transits our server. A password-shaped key appearing in the body would
    // defeat the reason the entry point exists.
    expect(Object.keys(transition.request?.body ?? {})).toEqual(["email", "type"]);
    expect(transition.prompt?.field).toBe("email-code");
  });

  it("joins the same code branch a password login falls into", () => {
    const viaCode = beginCodeLogin(ACCOUNT);
    const viaPassword = advance(beginPasswordLogin(ACCOUNT, PASSWORD).phase, {
      kind: "login-result",
      response: { loginType: "verifyCode" },
    });

    // One branch to maintain, and one to have got right, rather than two.
    expect(viaCode.phase).toEqual(viaPassword.phase);
    expect(viaCode.request).toEqual(viaPassword.request);
  });

  it("reaches a token from the code alone", () => {
    const start = beginCodeLogin(ACCOUNT);
    const submitted = advance(start.phase, { kind: "email-code", code: "123456" });
    const done = advance(submitted.phase, {
      kind: "login-result",
      response: { accessToken: TOKEN },
    });

    expect(submitted.request).toEqual({
      path: LOGIN_PATH,
      body: { account: ACCOUNT, code: "123456" },
    });
    expect(done.phase).toEqual({ kind: "authenticated", accessToken: TOKEN });
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
  // Bambu's authenticator endpoint has answered 403 missing_cookie since
  // 2026-08-01, so a two-factor account is routed to the emailed code instead.
  it("asks Bambu to email a code instead of calling the two-factor endpoint", () => {
    const start = beginPasswordLogin(ACCOUNT, PASSWORD);
    const asked = advance(start.phase, {
      kind: "login-result",
      response: { loginType: "tfa", tfaKey: "key-1" },
    });

    expect(asked.phase).toEqual({ kind: "await-email-code", account: ACCOUNT });
    expect(asked.request).toEqual({
      path: SEND_EMAIL_CODE_PATH,
      body: { email: ACCOUNT, type: "codeLogin" },
    });
    expect(asked.prompt?.field).toBe("email-code");
  });

  it("tells the user to check email rather than their authenticator app", () => {
    const start = beginPasswordLogin(ACCOUNT, PASSWORD);
    const asked = advance(start.phase, {
      kind: "login-result",
      response: { loginType: "tfa", tfaKey: "key-1" },
    });
    expect(asked.prompt?.message).toMatch(/emailed code/);
    expect(asked.prompt?.message).toMatch(/rather than your authenticator app/);
  });

  it("never sends the tfaKey anywhere", () => {
    const start = beginPasswordLogin(ACCOUNT, PASSWORD);
    const asked = advance(start.phase, {
      kind: "login-result",
      response: { loginType: "tfa", tfaKey: "key-1" },
    });
    expect(JSON.stringify(asked)).not.toContain("key-1");
  });

  it("does not need a tfaKey to proceed", () => {
    const start = beginPasswordLogin(ACCOUNT, PASSWORD);
    const asked = advance(start.phase, { kind: "login-result", response: { loginType: "tfa" } });
    expect(asked.phase.kind).toBe("await-email-code");
  });

  it("completes through the same code exchange as a verifyCode account", () => {
    const asked = advance(
      { kind: "await-login-result", account: ACCOUNT },
      { kind: "login-result", response: { loginType: "tfa" } },
    );
    const submitted = advance(asked.phase, { kind: "email-code", code: "654321" });
    expect(submitted.request).toEqual({
      path: LOGIN_PATH,
      body: { account: ACCOUNT, code: "654321" },
    });
    const done = advance(submitted.phase, {
      kind: "login-result",
      response: { accessToken: TOKEN },
    });
    expect(done.phase).toEqual({ kind: "authenticated", accessToken: TOKEN });
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
      failure: { code: "code-rejected", message: "m", guidance: "g" },
    };
    expect(expectFailure(advance(settled, { kind: "email-code", code: "1" })).code).toBe(
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

/**
 * Bambu Cloud login, as a pure state machine.
 *
 * The three observed login branches are password-only, email verification code,
 * and two-factor. All of them are reverse-engineered from OpenBambuAPI and
 * ha-bambulab and can change without notice.
 *
 * This module performs no I/O. It imports nothing from `node:*`, never calls
 * `fetch`, and never writes to a stream. The caller drives it: it performs the
 * request the machine asks for, reads the secret the machine asks for, and
 * feeds the result back. That split is what makes the branches testable
 * without a network and without a terminal.
 *
 * The machine never retains a password or a verification code. A secret appears
 * exactly once, inside the request body the caller is about to send, and never
 * in a phase object.
 */

export interface LoginResponse {
  accessToken?: string;
  refreshToken?: string;
  loginType?: string;
  tfaKey?: string;
}

/** A request the caller must POST to the cloud API. */
export interface CloudRequest {
  path: string;
  body: Record<string, unknown>;
}

export interface AuthFailure {
  code:
    | "unknown-login-type"
    | "missing-tfa-key"
    | "no-token"
    | "code-rejected"
    | "unexpected-event";
  /** What happened. Never a secret, never a response body. */
  message: string;
  /** What the user does next, in the imperative. */
  guidance: string;
}

export type AuthPhase =
  | { kind: "await-login-result"; account: string }
  | { kind: "await-email-code"; account: string }
  | { kind: "await-code-login-result"; account: string }
  | { kind: "await-tfa-code"; tfaKey: string }
  | { kind: "await-tfa-result" }
  | { kind: "authenticated"; accessToken: string }
  | { kind: "failed"; failure: AuthFailure };

export type AuthEvent =
  | { kind: "login-result"; response: LoginResponse }
  | { kind: "email-code"; code: string }
  | { kind: "tfa-code"; code: string };

export interface AuthPrompt {
  field: "email-code" | "tfa-code";
  /** Shown verbatim by the caller. Says why the secret is needed. */
  message: string;
}

export interface AuthTransition {
  phase: AuthPhase;
  /** The caller POSTs this next, if present. */
  request: CloudRequest | null;
  /** The caller reads this value without echoing it, if present. */
  prompt: AuthPrompt | null;
}

export const LOGIN_PATH = "/v1/user-service/user/login";
export const SEND_EMAIL_CODE_PATH = "/v1/user-service/user/sendemail/code";
export const TFA_PATH = "/v1/user-service/user/tfa";

const RERUN = "Run `pnpm setup` again to start a fresh login.";

function fail(
  code: AuthFailure["code"],
  message: string,
  guidance: string,
): AuthTransition {
  return {
    phase: { kind: "failed", failure: { code, message, guidance } },
    request: null,
    prompt: null,
  };
}

/** An empty string is a token that is not there. */
function tokenOf(response: LoginResponse): string | null {
  const token = response.accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

export function beginPasswordLogin(account: string, password: string): AuthTransition {
  return {
    phase: { kind: "await-login-result", account },
    // The password lives only in this body. The phase above cannot carry it.
    request: { path: LOGIN_PATH, body: { account, password, apiError: "" } },
    prompt: null,
  };
}

export function advance(phase: AuthPhase, event: AuthEvent): AuthTransition {
  if (phase.kind === "await-login-result" && event.kind === "login-result") {
    return afterFirstLogin(phase.account, event.response);
  }

  if (phase.kind === "await-email-code" && event.kind === "email-code") {
    return {
      phase: { kind: "await-code-login-result", account: phase.account },
      request: { path: LOGIN_PATH, body: { account: phase.account, code: event.code } },
      prompt: null,
    };
  }

  if (phase.kind === "await-code-login-result" && event.kind === "login-result") {
    const token = tokenOf(event.response);
    if (token !== null) {
      return { phase: { kind: "authenticated", accessToken: token }, request: null, prompt: null };
    }
    return fail(
      "code-rejected",
      "Bambu Cloud did not accept that verification code.",
      `Check the newest code in your email inbox; codes expire quickly. ${RERUN}`,
    );
  }

  if (phase.kind === "await-tfa-code" && event.kind === "tfa-code") {
    return {
      phase: { kind: "await-tfa-result" },
      request: { path: TFA_PATH, body: { tfaKey: phase.tfaKey, tfaCode: event.code } },
      prompt: null,
    };
  }

  if (phase.kind === "await-tfa-result" && event.kind === "login-result") {
    const token = tokenOf(event.response);
    if (token !== null) {
      return { phase: { kind: "authenticated", accessToken: token }, request: null, prompt: null };
    }
    return fail(
      "no-token",
      "Bambu Cloud accepted the two-factor step but returned no access token.",
      `Confirm the code came from the authenticator app bound to this account. ${RERUN}`,
    );
  }

  return fail(
    "unexpected-event",
    `Login step "${event.kind}" does not belong in phase "${phase.kind}".`,
    RERUN,
  );
}

function afterFirstLogin(account: string, response: LoginResponse): AuthTransition {
  const token = tokenOf(response);
  if (token !== null) {
    return { phase: { kind: "authenticated", accessToken: token }, request: null, prompt: null };
  }

  if (response.loginType === "verifyCode") {
    return {
      phase: { kind: "await-email-code", account },
      request: { path: SEND_EMAIL_CODE_PATH, body: { email: account, type: "codeLogin" } },
      prompt: {
        field: "email-code",
        message:
          "Bambu Cloud emailed a verification code to that account. It is used for this one request and is never written to disk.",
      },
    };
  }

  if (response.loginType === "tfa") {
    if (typeof response.tfaKey !== "string" || response.tfaKey.length === 0) {
      return fail(
        "missing-tfa-key",
        "Bambu Cloud asked for a two-factor code but returned no tfaKey.",
        `This is a cloud-side change rather than a mistake on your side. Retry later, or paste an access token exported from another Bambu client. ${RERUN}`,
      );
    }
    return {
      phase: { kind: "await-tfa-code", tfaKey: response.tfaKey },
      request: null,
      prompt: {
        field: "tfa-code",
        message:
          "This account has two-factor authentication enabled. The code is used for this one request and is never written to disk.",
      },
    };
  }

  const named = response.loginType ?? "none";
  return fail(
    "unknown-login-type",
    `Bambu Cloud answered with an unrecognized login type: "${named}".`,
    `The cloud login flow has changed. Paste an access token exported from another Bambu client for now, and please open an issue so it can be fixed. ${RERUN}`,
  );
}

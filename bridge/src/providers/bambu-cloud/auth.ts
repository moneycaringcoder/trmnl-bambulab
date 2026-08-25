/**
 * Bambu Cloud login, as a pure state machine.
 *
 * Two observed login branches: a password alone is sometimes enough, and
 * otherwise the cloud emails a verification code. Both are reverse-engineered
 * from OpenBambuAPI and ha-bambulab and can change without notice.
 *
 * There is deliberately no authenticator-app branch. Bambu's two-factor
 * endpoint lives on the website host rather than the API host, and since
 * 2026-08-01 it has rejected every submission with HTTP 403 and a body naming
 * `missing_cookie`: it requires a CSRF cookie that the API-host login sequence
 * never issues, and it refuses before the code is even examined. An account
 * with two-factor enabled therefore signs in with an emailed code, which runs
 * on the host we already talk to and needs no cookie.
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
  code: "unknown-login-type" | "code-rejected" | "unexpected-event";
  /** What happened. Never a secret, never a response body. */
  message: string;
  /** What the user does next, in the imperative. */
  guidance: string;
}

export type AuthPhase =
  | { kind: "await-login-result"; account: string }
  | { kind: "await-email-code"; account: string }
  | { kind: "await-code-login-result"; account: string }
  | { kind: "authenticated"; accessToken: string }
  | { kind: "failed"; failure: AuthFailure };

export type AuthEvent =
  | { kind: "login-result"; response: LoginResponse }
  | { kind: "email-code"; code: string };

export interface AuthPrompt {
  field: "email-code";
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

const RERUN = "Run `pnpm setup` again to start a fresh login.";

const ONE_USE =
  "It is used for this one request and is never written to disk, logged, or shown on screen.";

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

/**
 * The single place a token enters the bridge from the cloud, so it is also the
 * place surrounding whitespace is dropped. An empty string is a token that is
 * not there.
 */
function tokenOf(response: LoginResponse): string | null {
  const token = typeof response.accessToken === "string" ? response.accessToken.trim() : "";
  return token.length > 0 ? token : null;
}

export function beginPasswordLogin(account: string, password: string): AuthTransition {
  return {
    phase: { kind: "await-login-result", account },
    // The password lives only in this body. The phase above cannot carry it.
    request: { path: LOGIN_PATH, body: { account, password, apiError: "" } },
    prompt: null,
  };
}

/**
 * Starts a login that never involves a password.
 *
 * Bambu's `sendemail/code` endpoint takes an address and a `codeLogin` type,
 * and the login endpoint accepts `{ account, code }`, so the emailed code is a
 * complete credential on its own rather than only a second factor. That makes a
 * password avoidable, which matters most for the hosted tier: a hosted sign-in
 * that asked for a Bambu password would put it through our server for no gain,
 * and `AGENTS.md` is emphatic that a password is used once and discarded. Not
 * receiving one at all is strictly better than discarding one carefully.
 *
 * The bridge keeps offering the password entry point, because it runs on the
 * user's own machine and one request beats waiting for an email.
 *
 * **Unverified.** A real sign-in reached this endpoint only after a
 * password attempt had already returned `verifyCode`. Whether Bambu will email
 * a code with no prior password request is untested against a real account. If
 * it refuses, the hosted flow needs the password after all, and that is a
 * product decision rather than a bug here.
 */
export function beginCodeLogin(account: string): AuthTransition {
  return {
    phase: { kind: "await-email-code", account },
    request: { path: SEND_EMAIL_CODE_PATH, body: { email: account, type: "codeLogin" } },
    prompt: {
      field: "email-code",
      message: `Bambu Cloud is emailing a sign-in code to that address. ${ONE_USE}`,
    },
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

  // Both code-bearing branches are answered the same way, because the emailed
  // code is the only second factor that currently works. Only the explanation
  // differs, and the two-factor explanation has to correct the user's
  // reasonable assumption that they should open their authenticator app.
  const why =
    response.loginType === "verifyCode"
      ? "Bambu Cloud emailed a verification code to that account."
      : response.loginType === "tfa"
        ? "This account has two-factor authentication enabled. Bambu's authenticator endpoint has " +
          "rejected every code since 2026-08-01, so signing in uses an emailed code instead: " +
          "check your inbox rather than your authenticator app."
        : null;

  if (why !== null) {
    return {
      phase: { kind: "await-email-code", account },
      request: { path: SEND_EMAIL_CODE_PATH, body: { email: account, type: "codeLogin" } },
      prompt: { field: "email-code", message: `${why} ${ONE_USE}` },
    };
  }

  const named = response.loginType ?? "none";
  return fail(
    "unknown-login-type",
    `Bambu Cloud answered with an unrecognized login type: "${named}".`,
    `The cloud login flow has changed. Paste an access token exported from another Bambu client for now, and please open an issue so it can be fixed. ${RERUN}`,
  );
}

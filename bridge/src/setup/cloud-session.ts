/**
 * The I/O half of Bambu Cloud authentication.
 *
 * `providers/bambu-cloud/auth.ts` owns the branching logic and performs no I/O;
 * this module owns the prompting and the requests and performs no logic. The
 * password and any verification code exist only as a local binding here and in
 * the single request body they are sent in: never a field, never a file, never
 * a log line, never a process argument.
 */

import {
  advance,
  beginPasswordLogin,
  type AuthTransition,
  type CloudRequest,
  type LoginResponse,
} from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/auth";
import { CloudError, request } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/http";
import type { CloudHosts } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/hosts";
import { preference } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/api";
import { accountHintFor } from "./config.ts";
import { SetupError } from "./errors.ts";
import { ask, askSecret, askValid } from "./prompt.ts";
import { say, step } from "./ui.ts";

export interface CloudSession {
  accessToken: string;
  /** Masked. The raw email is never stored. */
  accountHint: string | null;
}

/** Where the failure happened, which decides what the user should do next. */
export type CloudContext = "login" | "token-check" | "request";

/**
 * Turns a transport failure into an instruction. A bare status code is never
 * shown to the user.
 */
export function describeCloudError(error: unknown, during: CloudContext): SetupError {
  if (!(error instanceof CloudError)) {
    return new SetupError(
      "Bambu Cloud request failed for an unexpected reason.",
      "Run the command again. If it keeps failing, check this machine's internet connection and whether status.bambulab.com reports an incident.",
    );
  }

  switch (error.category) {
    case "unauthorized-or-expired":
      if (during === "login") {
        return new SetupError(
          "Bambu Cloud rejected that sign-in.",
          "Check the email address and password in the Bambu Handy app or Bambu Studio, then run `pnpm setup` again. Nothing was written and no retry was attempted.",
        );
      }
      if (during === "token-check") {
        return new SetupError(
          "Bambu Cloud refused the new token.",
          "If you pasted a token, copy the whole value again with nothing trimmed. If you signed in, run `pnpm setup` once more. Nothing was written.",
        );
      }
      return new SetupError(
        "Your Bambu Cloud token expired or was revoked.",
        "Run `pnpm setup reauth` to get a fresh one. Bambu Cloud is the only data source, so the display stops updating until you do.",
      );
    case "blocked-by-cloudflare":
      return new SetupError(
        "Bambu Cloud answered with a bot challenge instead of an API response.",
        "Wait several minutes and try once more. Do not retry in a loop, which makes a challenge more likely, not less.",
      );
    case "rate-limited":
      return new SetupError(
        "Bambu Cloud is rate-limiting this account.",
        "Wait a few minutes before trying again. Repeated sign-in attempts make this worse.",
      );
    case "server-error":
      return new SetupError(
        "Bambu Cloud had a server error.",
        "Nothing is wrong with your configuration. Try again in a few minutes.",
      );
    case "timeout":
      return new SetupError(
        "Bambu Cloud did not answer in time.",
        "Check this machine's internet connection and try again.",
      );
    case "network-error":
      return new SetupError(
        "This machine could not reach Bambu Cloud.",
        "Check its internet connection, DNS, and any outbound proxy, then try again.",
      );
    case "response-too-large":
      return new SetupError(
        "Bambu Cloud returned more data than this client can safely accept.",
        "The reverse-engineered cloud API may have changed. Check for an update to this project before trying again.",
      );
    case "client-error":
      return new SetupError(
        `Bambu Cloud refused the request (HTTP ${error.status}).`,
        "This usually means the reverse-engineered cloud API changed. Check for an update to this project, and please open an issue with the status code.",
      );
  }
}

function postLogin(hosts: CloudHosts, call: CloudRequest): Promise<LoginResponse> {
  return request<LoginResponse>(hosts, call.path, { method: "POST", body: call.body });
}

/**
 * Drives the login state machine. Every secret is read with a hidden prompt and
 * dropped as soon as the request that needs it has been sent.
 */
export async function interactiveLogin(hosts: CloudHosts): Promise<CloudSession> {
  say();
  step("Your password is sent to Bambu Cloud once, to exchange it for an access token.");
  step("It is never written to disk, never logged, and never shown on screen.");
  step("Only the resulting token, and a masked form of your email, are stored.");
  say();

  const account = await askValid("Bambu account email", (raw) => {
    const value = raw.trim();
    return value.includes("@") && value.length > 3
      ? { ok: true as const, value }
      : {
          ok: false as const,
          message: "That does not look like an email address.",
          guidance: "Use the email address you sign in to Bambu Handy or Bambu Studio with.",
        };
  });

  let transition: AuthTransition;
  {
    // Scoped so the password leaves scope as soon as the first request is built.
    const password = await askSecret("Password (hidden, not stored)");
    if (password === "") {
      throw new SetupError(
        "No password was entered.",
        "Run `pnpm setup` again, or choose the access-token path instead of an interactive sign-in.",
      );
    }
    transition = beginPasswordLogin(account, password);
  }

  for (;;) {
    const phase = transition.phase;

    if (phase.kind === "authenticated") {
      return { accessToken: phase.accessToken, accountHint: accountHintFor(account) };
    }
    if (phase.kind === "failed") {
      throw new SetupError(phase.failure.message, phase.failure.guidance);
    }

    if (transition.request !== null) {
      let response: LoginResponse;
      try {
        response = await postLogin(hosts, transition.request);
      } catch (error) {
        throw describeCloudError(error, "login");
      }

      if (phase.kind === "await-login-result" || phase.kind === "await-code-login-result") {
        transition = advance(phase, { kind: "login-result", response });
        continue;
      }
      // Otherwise the request was a side effect, such as sending the email
      // code, and the next input is the prompt below.
    }

    if (transition.prompt !== null) {
      say();
      step(transition.prompt.message);
      const code = await askSecret("Code (hidden, not stored)");
      transition = advance(phase, { kind: "email-code", code });
      continue;
    }

    throw new SetupError(
      "The Bambu Cloud sign-in stopped without producing a token.",
      "Run `pnpm setup` again. If it keeps happening, paste an access token exported from another Bambu client instead, and please open an issue.",
    );
  }
}

/** Accepts a token the user exported from another Bambu client. */
export async function pasteToken(): Promise<CloudSession> {
  say();
  step("Paste an existing Bambu Cloud access token. It is stored in bridge/.env at mode 0600.");
  step("The token is hidden while you type and is never echoed back.");
  say();

  // No format check: Bambu tokens are opaque and the format has changed before,
  // so the only thing worth rejecting is a paste that obviously went wrong.
  // Whether the token actually works is settled a moment later by `verifyToken`.
  const accessToken = await askValid(
    "Access token (hidden)",
    (raw) => {
      const value = raw.trim();
      return value.length > 0 && !/\s/.test(value)
        ? { ok: true as const, value }
        : {
            ok: false as const,
            message: "That is empty, or it contains a space or a line break.",
            guidance:
              "Copy the whole token value, with nothing trimmed from either end and no surrounding quotes.",
          };
    },
    { secret: true },
  );

  return { accessToken, accountHint: null };
}

/**
 * Confirms the token works, using the cheapest read-only endpoint. `during`
 * decides the advice: a freshly pasted token that is refused was mistyped, a
 * stored one that is refused has expired.
 */
export async function verifyToken(
  hosts: CloudHosts,
  accessToken: string,
  during: CloudContext = "request",
): Promise<void> {
  try {
    await preference(hosts, accessToken);
  } catch (error) {
    throw describeCloudError(error, during);
  }
}

/** Asks whether to sign in interactively or paste a token. */
export async function askAccountHint(): Promise<string | null> {
  const answer = (await ask("Bambu account email, for the reauthentication prompt only", "skip")).trim();
  return answer === "" || answer.toLowerCase() === "skip" ? null : accountHintFor(answer);
}

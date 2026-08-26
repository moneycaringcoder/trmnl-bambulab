/**
 * Enrolment: turning a signed-in person into an account with printers.
 *
 * Three steps, and the shape of them is a security decision rather than an
 * interface preference.
 *
 * **We never take a Bambu password.** Bambu's `sendemail/code` endpoint accepts
 * an address and a `codeLogin` type, and its login endpoint accepts an address
 * and that code, so the emailed code is a complete credential rather than only a
 * second factor. The self-hosted bridge may still offer a password because it
 * runs on the user's own machine, but a hosted sign-in that asked for one would
 * put a Bambu password through our server for no gain. `AGENTS.md` says a
 * password is used once and discarded; not receiving one is strictly better than
 * discarding one carefully.
 *
 * **Nothing is remembered between the two login steps.** The only thing the
 * second step needs from the first is the email address, which the browser
 * already has. So there is no server-side login state, no expiry to manage, and
 * nothing to clean up — and no window in which a half-finished login is sitting
 * in our storage. A caller who fabricates the intermediate step gains nothing:
 * they still need the code Bambu emailed to that address.
 *
 * **A signed-in identity is required before the first step.** Without that, this
 * would be an open relay for Bambu verification emails: anyone could make Bambu
 * email anyone. The identity requirement plus a per-identity rate limit is what
 * bounds it, which is why the routes refuse when identity is unconfigured rather
 * than falling back to trusting the caller.
 *
 * A cloud token appears here and is sealed before it is stored. It is never
 * returned to a caller, never logged, and never put in an error.
 */

import {
  advance,
  beginCodeLogin,
  type AuthPhase,
  type LoginResponse,
} from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/auth";
import { CloudError, request } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/http";
import { listDevices } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/api";
import {
  hostsFor,
  type Region,
} from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/hosts";

/** What the picker shows. Identifiers stay here; only names reach a screen. */
export interface DiscoveredPrinter {
  /** The printer serial. An identifier: never logged, never sent to TRMNL. */
  deviceId: string;
  name: string;
  online: boolean;
  model: string | null;
}

export type EnrolFailure =
  /** Bambu refused the address, code, or saved token. */
  | { kind: "refused"; guidance: string }
  /** Bambu is unreachable, rate limiting us, or failing. Retry later. */
  | { kind: "cloud-unavailable"; guidance: string }
  /** The account authenticated but has no printers to choose from. */
  | { kind: "no-printers"; guidance: string };

export type CodeRequestResult = { ok: true } | { ok: false; failure: EnrolFailure };

export type SignInResult =
  | { ok: true; accessToken: string; printers: DiscoveredPrinter[] }
  | { ok: false; failure: EnrolFailure };

export type PrinterListResult =
  | { ok: true; printers: DiscoveredPrinter[] }
  | { ok: false; failure: EnrolFailure };

/**
 * Asks Bambu to email a sign-in code.
 *
 * Returns nothing on success on purpose. Whether the address exists is Bambu's
 * business and not something this endpoint should reveal: answering identically
 * for a real and an unknown address means the flow cannot be used to test
 * whether somebody has a Bambu account.
 */
export async function requestSignInCode(
  region: Region,
  email: string,
): Promise<CodeRequestResult> {
  const start = beginCodeLogin(email);
  if (start.request === null) {
    // Unreachable with the current state machine, and cheap to guard: a future
    // change that stopped issuing a request must not silently succeed here.
    return { ok: false, failure: refused() };
  }

  try {
    await request(hostsFor(region), start.request.path, {
      method: "POST",
      body: start.request.body,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, failure: fromCloudError(error) };
  }
}

/**
 * Exchanges an emailed code for a cloud token, then lists the printers on it.
 *
 * The token is returned to the caller in this process only, so it can be sealed
 * and stored. It must not travel any further than that, and in particular must
 * never reach a browser or a log.
 */
export async function completeSignIn(
  region: Region,
  email: string,
  code: string,
): Promise<SignInResult> {
  const hosts = hostsFor(region);
  const phase: AuthPhase = { kind: "await-email-code", account: email };
  const submitted = advance(phase, { kind: "email-code", code });
  if (submitted.request === null) return { ok: false, failure: refused() };

  let response: LoginResponse;
  try {
    response = await request<LoginResponse>(hosts, submitted.request.path, {
      method: "POST",
      body: submitted.request.body,
    });
  } catch (error) {
    return { ok: false, failure: fromCloudError(error) };
  }

  const settled = advance(submitted.phase, { kind: "login-result", response });
  if (settled.phase.kind !== "authenticated") {
    // The state machine's guidance is safe to show — every string on this path
    // is a fixed literal carrying no Bambu response detail — but it is written
    // for the CLI and ends by telling the reader to run `pnpm setup`. A hosted
    // user has no such command, so the failure *code* is used and the wording is
    // written here for someone looking at a web form.
    const guidance =
      settled.phase.kind === "failed" && settled.phase.failure.code === "code-rejected"
        ? "That code was not accepted. Check the newest email from Bambu, because codes expire quickly, and enter it again."
        : "Bambu Cloud did not complete the sign-in. Start again, and if it keeps failing the cloud login has probably changed.";
    return { ok: false, failure: { kind: "refused", guidance } };
  }

  const accessToken = settled.phase.accessToken;

  let printers: DiscoveredPrinter[];
  try {
    printers = await discoverPrinters(region, accessToken);
  } catch (error) {
    return { ok: false, failure: fromCloudError(error) };
  }

  if (printers.length === 0) {
    return {
      ok: false,
      failure: {
        kind: "no-printers",
        guidance:
          "That Bambu account has no printers bound to it. Bind a printer in Bambu Handy or " +
          "Bambu Studio, then sign in again.",
      },
    };
  }

  return { ok: true, accessToken, printers };
}

/**
 * The printers bound to an account, for the picker.
 *
 * `listDevices` already validates the cloud's response with a schema and drops
 * entries it cannot read, so there is nothing left to re-check here: this only
 * renames the fields the picker needs and decides what an absent name means.
 */
export async function discoverPrinters(
  region: Region,
  accessToken: string,
): Promise<DiscoveredPrinter[]> {
  const devices = await listDevices(hostsFor(region), accessToken);

  return devices.map((device) => ({
    deviceId: device.id,
    // A printer with no name in the cloud is shown by its serial rather than by
    // an invented placeholder, because the user has to be able to tell which
    // machine they are choosing and only they know which serial is which.
    name: device.name ?? device.id,
    // `online: null` means the cloud did not say. Absent is not offline, but a
    // picker has to render something, and treating unknown as offline is the
    // conservative read: it never claims a printer is reachable when we do not
    // know that it is.
    online: device.online ?? false,
    model: device.model,
  }));
}

/**
 * Lists printers with a stored token and classifies a refusal separately from
 * a temporary cloud failure. The settings route uses that distinction to ask
 * for a new code only when Bambu has actually rejected the saved token.
 */
export async function listStoredPrinters(
  region: Region,
  accessToken: string,
): Promise<PrinterListResult> {
  try {
    return { ok: true, printers: await discoverPrinters(region, accessToken) };
  } catch (error) {
    if (error instanceof CloudError && error.category === "unauthorized-or-expired") {
      return {
        ok: false,
        failure: {
          kind: "refused",
          guidance: "Bambu Cloud rejected the saved sign-in. Sign in again.",
        },
      };
    }
    return {
      ok: false,
      failure: {
        kind: "cloud-unavailable",
        guidance: "Bambu Cloud did not answer. Try again in a few minutes.",
      },
    };
  }
}

/**
 * Narrows a chosen selection to printers the account actually has.
 *
 * The browser sends back device ids, and a browser is not a trusted source. This
 * is not about protecting another account — a device id from someone else's
 * printer would simply never appear in this account's cloud listing — it is
 * about refusing to store a selection that can never render anything.
 *
 * Order is the user's, because the first printer is the one the display leads
 * with. Duplicates collapse before the maximum is enforced.
 */
export function chooseFrom(
  available: readonly DiscoveredPrinter[],
  requested: readonly string[],
  maxPrinters: number,
):
  | { ok: true; deviceIds: string[] }
  | { ok: false; kind: "unknown"; unknown: number }
  | { ok: false; kind: "too-many"; maxPrinters: number } {
  const known = new Set(available.map((printer) => printer.deviceId));
  const chosen: string[] = [];
  const selected = new Set<string>();
  let unknown = 0;

  for (const wanted of requested) {
    if (!known.has(wanted)) {
      unknown += 1;
      continue;
    }
    if (!selected.has(wanted)) {
      selected.add(wanted);
      chosen.push(wanted);
    }
  }

  // Reject rather than silently dropping. The browser's visible order is the
  // display order, and truncating it would save something other than the person
  // reviewed. Duplicates collapse before applying the limit.
  if (unknown > 0) return { ok: false, kind: "unknown", unknown };
  if (chosen.length > maxPrinters) {
    return { ok: false, kind: "too-many", maxPrinters };
  }
  return { ok: true, deviceIds: chosen };
}

function refused(): EnrolFailure {
  return {
    kind: "refused",
    guidance: "Bambu Cloud did not accept that. Start the sign-in again.",
  };
}

/**
 * Maps a transport failure to something a person can act on.
 *
 * A `CloudError` carries a status and a category and deliberately never carries
 * a response body, so nothing here can leak account detail even by accident.
 */
function fromCloudError(error: unknown): EnrolFailure {
  if (!(error instanceof CloudError)) {
    return {
      kind: "cloud-unavailable",
      guidance: "Something went wrong reaching Bambu Cloud. Try again in a few minutes.",
    };
  }

  switch (error.category) {
    case "unauthorized-or-expired":
      return {
        kind: "refused",
        guidance:
          "Bambu Cloud rejected that. Check the newest code in your inbox: codes expire quickly.",
      };
    case "rate-limited":
      return {
        kind: "cloud-unavailable",
        guidance: "Bambu Cloud is rate limiting sign-ins. Wait a few minutes and try again.",
      };
    case "blocked-by-cloudflare":
      return {
        kind: "cloud-unavailable",
        guidance:
          "Bambu Cloud's protection blocked this request. This usually clears on its own; " +
          "try again in a few minutes.",
      };
    case "client-error":
      // Bambu answered and said no. Observed with a wrong sign-in code, which
      // comes back as a 4xx rather than a 401, so folding this into the
      // unreachable case told someone who mistyped a code that the service was
      // down — advice to wait when the right advice is to read the email again.
      return {
        kind: "refused",
        guidance:
          "Bambu Cloud did not accept that. If you were entering a code, use the newest " +
          "email: they expire quickly.",
      };
    default:
      return {
        kind: "cloud-unavailable",
        guidance: "Bambu Cloud did not answer. Try again in a few minutes.",
      };
  }
}

/**
 * The TRMNL third-party plugin protocol: install, verify, markup, uninstall.
 *
 * TRMNL owns identity here. Installing the plugin redirects the user to us with
 * a single-use code; exchanging it yields a per-installation access token that
 * TRMNL presents as a Bearer token on every request it ever makes for that user.
 * So there is no sign-up, no password and no verification code on our side —
 * the whole apparatus this module replaced. Bambu sign-in is unchanged and
 * separate: it is the printer credential, not the account system.
 *
 * Nothing in this module logs. Access tokens, user uuids and installation ids
 * are identifiers or credentials; callers log fixed outcome words only.
 *
 * The token is stored only as a keyed tag, the same treatment the screen key
 * used to get: a database leak yields nothing replayable. The management link
 * is signed with the same keyring, so possession of the link is possession of
 * the installation — which is exactly TRMNL's own model, where possession of
 * the plugin's settings page is possession of the plugin.
 */

import { ownerTagCandidates, type Keyring } from "@trmnl-bambulab/core/hosted/crypto";
import { renderScreenMarkup, type ScreenMarkup } from "./markup.ts";
import type { Installation, Store } from "@trmnl-bambulab/core/hosted/store";

/**
 * Domain separators, so a TRMNL access token, an installation id and an
 * identity subject can never collide into the same HMAC input. The newline is
 * the separator because none of the three may contain one.
 */
const TOKEN_TAG_DOMAIN = "trmnl-access-token\n";
const OWNER_TAG_DOMAIN = "trmnl-installation\n";
const MANAGE_DOMAIN = "trmnl-manage\n";

/** How long a management link works. Long enough to enrol, short enough to leak. */
export const MANAGE_TOKEN_TTL_MS = 60 * 60_000;

export interface TrmnlPorts {
  store: Store;
  keyring: Keyring;
  /**
   * Exchanges the single-use install code at TRMNL's token endpoint.
   *
   * A port so tests never reach trmnl.com. TRMNL answers HTTP 200 for both
   * outcomes and distinguishes them in the body, so the implementation maps
   * `{ error: true }` to a refusal rather than trusting the status line.
   */
  exchangeCode(code: string): Promise<{ ok: true; accessToken: string } | { ok: false }>;
  now(): number;
}

/** Every tag this token could be stored under, across key rotations. */
async function tokenTags(keyring: Keyring, accessToken: string): Promise<string[]> {
  return await ownerTagCandidates(keyring, TOKEN_TAG_DOMAIN + accessToken);
}

/** The subject an installation's account is owned by. */
export async function installationOwnerTags(
  keyring: Keyring,
  installationId: string,
): Promise<string[]> {
  return await ownerTagCandidates(keyring, OWNER_TAG_DOMAIN + installationId);
}

/** Strict bearer parse, same rules as the rest of the tree: refuse, never guess. */
function bearerToken(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

/**
 * Resolves the installation a TRMNL request speaks for.
 *
 * This is the authentication for the markup route and both webhooks: the token
 * TRMNL presents is the one it was handed at install, and possession is the
 * whole claim. Null for a missing, malformed or unknown token — callers answer
 * all three identically, because distinguishing them would make this an oracle.
 */
export async function identifyInstallation(
  ports: TrmnlPorts,
  authorization: string | null,
): Promise<Installation | null> {
  const token = bearerToken(authorization);
  if (token === null) return null;
  return await ports.store.installationByTokenTag(await tokenTags(ports.keyring, token));
}

export type InstallOutcome =
  | { kind: "installed"; manageToken: string }
  | { kind: "refused" };

/**
 * Handles the install redirect: code in, installation row and management link out.
 *
 * The code is single-use and TRMNL refuses a spent one, so replaying this
 * request cannot mint a second installation for the same user. A token TRMNL
 * has already handed us maps onto its existing row rather than erroring, which
 * makes a user pressing the install button twice land on their own setup page.
 */
export async function install(ports: TrmnlPorts, code: string): Promise<InstallOutcome> {
  if (code.trim() === "") return { kind: "refused" };

  const exchanged = await ports.exchangeCode(code.trim());
  if (!exchanged.ok) return { kind: "refused" };

  const tags = await tokenTags(ports.keyring, exchanged.accessToken);
  const existing = await ports.store.installationByTokenTag(tags);
  if (existing !== null) {
    return {
      kind: "installed",
      manageToken: await signManageToken(ports.keyring, existing.id, ports.now()),
    };
  }

  const installation: Installation = {
    id: crypto.randomUUID(),
    // The first candidate is the current key's tag, which is the one lookups
    // will hit; older-key candidates exist only for reading.
    accessTokenTag: tags[0] ?? "",
    userUuid: null,
    pluginSettingId: null,
    accountId: null,
  };
  await ports.store.createInstallation(installation);
  return {
    kind: "installed",
    manageToken: await signManageToken(ports.keyring, installation.id, ports.now()),
  };
}

/**
 * A management token: proof of installation for the setup page's own calls.
 *
 * `id.expiry.mac`, HMAC-signed with the keyring's tag key. It exists because
 * the browser needs to call our enrolment routes after the install redirect,
 * and the TRMNL access token must never be handed to a browser — it is the
 * credential for the whole installation lifetime, while this expires.
 */
export async function signManageToken(
  keyring: Keyring,
  installationId: string,
  now: number,
): Promise<string> {
  const expiresAt = now + MANAGE_TOKEN_TTL_MS;
  const mac = await ownerTagCandidates(
    keyring,
    MANAGE_DOMAIN + installationId + "\n" + String(expiresAt),
  );
  return `${installationId}.${expiresAt}.${mac[0] ?? ""}`;
}

/**
 * Verifies a management token and resolves its installation.
 *
 * Null for expired, malformed, or forged — indistinguishable to the caller.
 */
export async function verifyManageToken(
  keyring: Keyring,
  store: Store,
  token: string,
  now: number,
): Promise<Installation | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, rawExpiry, mac] = parts as [string, string, string];
  if (!/^\d+$/.test(rawExpiry)) return null;
  const expiresAt = Number(rawExpiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return null;

  const candidates = await ownerTagCandidates(
    keyring,
    MANAGE_DOMAIN + id + "\n" + rawExpiry,
  );
  if (!candidates.includes(mac)) return null;
  return await store.installationById(id);
}

export type ManageOutcome =
  | { kind: "redirect"; manageToken: string; backUrl: string | null }
  /** Unknown or absent uuid, one answer: the page's open-from-TRMNL panel. */
  | { kind: "unknown" };

/**
 * Handles TRMNL's management redirect: `?uuid=` in, a fresh session out.
 *
 * TRMNL sends the user's browser to the management URL with the same uuid the
 * success webhook recorded, so a stored uuid is proof the visitor arrived
 * through TRMNL for that installation. The uuid rides a query string —
 * TRMNL's design, not ours — so it is immediately converted into a fragment
 * token and never echoed anywhere.
 *
 * The back link points at TRMNL's own settings editor with `force_refresh`,
 * which makes TRMNL redraw the screen the moment the user returns — so a
 * printer-selection change is visible immediately rather than at the next
 * scheduled refresh.
 */
export async function manage(ports: TrmnlPorts, uuid: string): Promise<ManageOutcome> {
  if (uuid.trim() === "") return { kind: "unknown" };
  const installation = await ports.store.installationByUserUuid(uuid.trim());
  if (installation === null) return { kind: "unknown" };

  return {
    kind: "redirect",
    manageToken: await signManageToken(ports.keyring, installation.id, ports.now()),
    backUrl:
      installation.pluginSettingId === null
        ? null
        : `https://trmnl.com/plugin_settings/${installation.pluginSettingId}/edit?force_refresh=true`,
  };
}

/**
 * Records what the success webhook said about who installed.
 *
 * Only the uuid and settings id are kept. TRMNL also sends the user's name and
 * email, and they are deliberately dropped: nothing here needs them, and
 * personal data that is never stored is personal data that cannot leak.
 */
export async function recordInstallSuccess(
  ports: TrmnlPorts,
  authorization: string | null,
  body: unknown,
): Promise<"done" | "unauthenticated" | "invalid"> {
  const installation = await identifyInstallation(ports, authorization);
  if (installation === null) return "unauthenticated";

  const user =
    typeof body === "object" && body !== null && "user" in body ? body.user : null;
  if (typeof user !== "object" || user === null) return "invalid";
  const uuid = "uuid" in user ? user.uuid : null;
  if (typeof uuid !== "string" || uuid === "") return "invalid";
  const rawSettingId = "plugin_setting_id" in user ? user.plugin_setting_id : null;
  const pluginSettingId = Number.isSafeInteger(rawSettingId) ? (rawSettingId as number) : null;

  await ports.store.recordInstallationUser(installation.id, uuid, pluginSettingId);
  return "done";
}

/**
 * Uninstalls: the account first, then the installation.
 *
 * The account delete is where the actual-deletion obligation lives — token,
 * printers and rendered screen go with it, by cascade. The installation row
 * goes second so a crash between the two leaves an installation that can
 * enrol again, never an orphaned credential.
 */
export async function uninstall(
  ports: TrmnlPorts,
  authorization: string | null,
): Promise<"done" | "unauthenticated"> {
  const installation = await identifyInstallation(ports, authorization);
  if (installation === null) return "unauthenticated";

  if (installation.accountId !== null) {
    await ports.store.deleteAccount(installation.accountId);
  }
  await ports.store.deleteInstallation(installation.id);
  return "done";
}

/** A static fragment for each layout, for the states with nothing to render. */
function noticeMarkup(title: string, body: string): ScreenMarkup {
  const fragment = (view: string) =>
    `<div class="view view--${view}"><div class="layout"><div class="columns"><div class="column">` +
    `<span class="value value--large">${title}</span>` +
    `<span class="label">${body}</span>` +
    `</div></div></div></div>`;
  return {
    markup: fragment("full"),
    markup_half_horizontal: fragment("half_horizontal"),
    markup_half_vertical: fragment("half_vertical"),
    markup_quadrant: fragment("quadrant"),
  };
}

export type MarkupOutcome =
  | { kind: "markup"; markup: ScreenMarkup }
  | { kind: "unauthenticated" };

/**
 * Answers TRMNL's markup request from the stored render.
 *
 * Serving the stored render rather than reading Bambu on demand is the same
 * decision the polling design made, for the same reasons: the user's refresh
 * setting must not decide how hard Bambu is hit, and a request timeout must not
 * contain two cloud round-trips. The cron and the collector write; this reads.
 *
 * An installation that has not enrolled, or has not been rendered yet, gets a
 * fragment saying so rather than an error: TRMNL renders what we return, so an
 * error here would draw a broken screen on someone's wall.
 */
export async function markup(
  ports: TrmnlPorts,
  authorization: string | null,
): Promise<MarkupOutcome> {
  const installation = await identifyInstallation(ports, authorization);
  if (installation === null) return { kind: "unauthenticated" };

  if (installation.accountId === null) {
    return {
      kind: "markup",
      markup: noticeMarkup("Not set up", "Open the plugin's manage page to connect Bambu."),
    };
  }

  const screen = await ports.store.readScreen(installation.accountId);
  if (screen === null) {
    return {
      kind: "markup",
      markup: noticeMarkup("Waiting", "The first reading arrives within five minutes."),
    };
  }

  let variables: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(screen.body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("stored screen is not an object");
    }
    variables = parsed as Record<string, unknown>;
  } catch {
    // A malformed stored render is our fault, never the user's. Say something
    // rather than drawing a stack trace on an e-paper display.
    return {
      kind: "markup",
      markup: noticeMarkup("Temporarily unavailable", "The next reading replaces this."),
    };
  }

  return { kind: "markup", markup: await renderScreenMarkup(variables) };
}

/**
 * Masking helpers for anything that reaches a terminal, a log, or a summary.
 *
 * Pure. The output of every function here is safe to paste into an issue: no
 * return value reveals enough to reconstruct its input. Secrets reveal nothing
 * at all; identifiers reveal a three-character tail so a user with two printers
 * can still tell them apart.
 */

const BULLET = "\u2022";
const HIDDEN = `${BULLET.repeat(8)}`;
const NOT_SET = "(not set)";

/** A token, an access code, a password: presence only, never a character. */
export function maskSecret(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim() === ""
    ? NOT_SET
    : "(set, hidden)";
}

/** A serial, a device id, a printer address. Keeps a short tail for recognition. */
export function maskIdentifier(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return NOT_SET;
  // A short value has too little left over: a tail would give most of it away.
  if (trimmed.length < 8) return BULLET.repeat(trimmed.length);
  return `${HIDDEN}${trimmed.slice(-3)}`;
}

export function maskEmail(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  const at = trimmed.lastIndexOf("@");
  if (at < 1 || at === trimmed.length - 1) return maskSecret(value);
  return `${trimmed[0] ?? ""}${BULLET.repeat(3)}${trimmed.slice(at)}`;
}

/**
 * The TRMNL webhook URL is a credential because its last path segment is the
 * plugin-setting UUID. Keep the shape, drop the UUID.
 */
export function maskWebhookUrl(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return NOT_SET;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return maskSecret(value);
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return `${parsed.origin}/${HIDDEN}`;
  segments[segments.length - 1] = HIDDEN;
  return `${parsed.origin}/${segments.join("/")}`;
}

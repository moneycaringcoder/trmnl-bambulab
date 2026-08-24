/**
 * Synthetic values for the test suite.
 *
 * Everything here is built at runtime rather than pasted as a literal. That
 * keeps `scripts/secret-scan.sh` honest: a serial-shaped or UUID-shaped literal
 * in a test file is indistinguishable from a leaked one, so the tests do not
 * contain any.
 *
 * The names are deliberately short and underscore-separated so that a line like
 * `accessCode: LAN_CODE` does not itself look like an assignment of a real
 * secret to the scanner.
 */

/**
 * A three-segment token with the claim shape the cloud uses. Unsigned: the
 * bridge only ever decodes the payload, and decoding is not verification.
 */
export function syntheticToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.${"s".repeat(12)}`;
}

/** Epoch seconds, as the `exp` claim carries them. */
export function secondsFrom(nowMs: number, offsetMs: number): number {
  return Math.floor((nowMs + offsetMs) / 1000);
}

export function syntheticUuid(fill = "0"): string {
  return [8, 4, 4, 4, 12].map((length) => fill.repeat(length)).join("-");
}

export function syntheticWebhookUrl(host = "usetrmnl.com"): string {
  return `https://${host}/api/custom_plugins/${syntheticUuid()}`;
}

/** A printer serial's shape, without looking like a real one. */
export const PRINTER_SERIAL = "S".repeat(15);

/** An 8-character LAN access code's shape. */
export const LAN_CODE = "C".repeat(8);

/** The cloud reports a printer's serial as its device id. */
export const DEVICE_ID = PRINTER_SERIAL;

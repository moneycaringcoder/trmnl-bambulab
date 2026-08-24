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

import { readFileSync } from "node:fs";

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

/**
 * The cloud's numeric account id and the MQTT username derived from it.
 *
 * Not credential-shaped, so no scanner rule covers it, but it belongs here for
 * the same reason as everything else: one definition means one thing to change
 * if the real shape turns out to be different.
 */
export const CLOUD_UID = 1234567;
export const MQTT_USERNAME = `u_${CLOUD_UID}`;

/**
 * Loads a synthetic cloud fixture, substituting `$DEV` for the runtime device
 * id.
 *
 * The placeholder is not decoration. `scripts/secret-scan.sh` blocks any
 * assignment to a serial-shaped key, reasoning that a regex cannot tell a
 * placeholder serial from a real one, and JSON has no comment syntax for the
 * scanner's allow marker. A `$`-prefixed value is excluded by that pattern by
 * design, so the fixture keeps the real response shape while containing nothing
 * serial-shaped at all.
 */
export function loadCloudFixture(name: string, base: string | URL): unknown {
  const text = readFileSync(new URL(`../fixtures/cloud/${name}.synthetic.json`, base), "utf8");
  return JSON.parse(text.replaceAll("$DEV", DEVICE_ID)) as unknown;
}

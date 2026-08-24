/**
 * Shared test values for the hosted tier.
 *
 * Everything here is built at runtime rather than pasted as a literal, for the
 * same reason `bridge/test/synthetic-values.ts` does it: a key-shaped or
 * token-shaped literal in a test file is indistinguishable from a leaked one,
 * both to a reader and to `scripts/secret-scan.sh`. So the tests contain none.
 */

import { generateKeyBase64, importKeyring, type Keyring } from "../src/crypto.ts";

/**
 * Stands in for a Bambu access token. Assembled from parts so no long
 * credential-shaped run of characters exists in the source.
 */
export const TOKEN = ["synthetic", "cloud", "token", "value"].join("-");

/**
 * A keyring with one current key, generated fresh per call.
 *
 * Generated rather than fixed so that no test can accidentally depend on a
 * particular key, and so nothing resembling real key material is ever written
 * down here.
 */
export async function keyringForTest(currentId = "k1"): Promise<Keyring> {
  return await importKeyring({ [currentId]: await generateKeyBase64() }, currentId);
}

/**
 * Encrypting a Bambu Cloud token at rest.
 *
 * The hosted tier necessarily holds a user's cloud token, because the user runs
 * nothing. `AGENTS.md` attaches obligations to that, and this module is the
 * first of them: the token is encrypted before it reaches the database and is
 * decrypted only in the moment it is used.
 *
 * AES-256-GCM through Web Crypto, which the Workers runtime provides natively.
 * GCM is authenticated, so a row someone tampered with fails to decrypt rather
 * than yielding plausible rubbish that gets sent to Bambu as a bearer token.
 *
 * Three decisions worth stating, because each has an obvious cheaper
 * alternative that is wrong:
 *
 * **A fresh 96-bit nonce per encryption, stored beside the ciphertext.**
 * Reusing a nonce under one AES-GCM key is not a weakening, it is a break: two
 * messages under the same key and nonce leak their XOR and expose the
 * authentication key. Nonces are therefore random per call and never derived
 * from anything about the row.
 *
 * **A key identifier travels with every ciphertext.** Rotating a key is not a
 * hypothetical: it is the response to a suspected compromise, and it is
 * impossible to do incrementally if a stored value does not say which key it
 * was sealed with. The cost is a few bytes.
 *
 * **The account id is authenticated as additional data.** It is not secret, so
 * it is not encrypted, but binding it means a ciphertext lifted from one row
 * cannot be replayed into another. Without it, anyone who can write to the
 * database can point their own row at someone else's token.
 *
 * Nothing here logs, and no error message contains a key, a nonce, a
 * ciphertext, or a plaintext. A failure says which of the two things went
 * wrong — the key is unknown, or the data did not authenticate — and no more.
 */

const ALGORITHM = "AES-GCM";
const NONCE_BYTES = 12;
const KEY_BITS = 256;

/** A key and the identifier that will be stored with everything it seals. */
export interface KeyEntry {
  /** Short, stable, and meaningless on its own, for example `k1`. */
  id: string;
  key: CryptoKey;
}

export interface Keyring {
  /** The key new ciphertexts are sealed with. */
  current: KeyEntry;
  /** Every key that may still appear in stored data, including the current one. */
  byId: Record<string, CryptoKey>;
}

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

/**
 * Builds a keyring from the Worker's secrets.
 *
 * `secrets` maps a key id to a base64 32-byte key. `currentId` names the one to
 * seal with. Keeping older keys present is what makes rotation a deploy rather
 * than a migration: new writes use the new key, old rows keep working, and a
 * background re-encryption can catch up whenever.
 */
export async function importKeyring(
  secrets: Record<string, string>,
  currentId: string,
): Promise<Keyring> {
  const byId: Record<string, CryptoKey> = {};

  for (const [id, encoded] of Object.entries(secrets)) {
    const raw = decodeBase64(encoded);
    if (raw.byteLength !== KEY_BITS / 8) {
      throw new CryptoError(`key "${id}" is not ${KEY_BITS / 8} bytes`);
    }
    byId[id] = await crypto.subtle.importKey("raw", raw, ALGORITHM, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  const current = byId[currentId];
  if (current === undefined) {
    throw new CryptoError(`the current key id "${currentId}" is not among the configured keys`);
  }
  return { current: { id: currentId, key: current }, byId };
}

/** What gets stored. Every field is safe to write to a database column. */
export interface SealedToken {
  keyId: string;
  /** Base64. Not secret, but must never repeat under one key. */
  nonce: string;
  /** Base64 ciphertext with the GCM tag appended, as Web Crypto returns it. */
  ciphertext: string;
}

export async function sealToken(
  keyring: Keyring,
  accountId: string,
  token: string,
): Promise<SealedToken> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: nonce, additionalData: new TextEncoder().encode(accountId) },
    keyring.current.key,
    new TextEncoder().encode(token),
  );

  return {
    keyId: keyring.current.id,
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(new Uint8Array(sealed)),
  };
}

/**
 * Recovers a token, or throws.
 *
 * A wrong account id, a tampered ciphertext and a retired key all end here.
 * They are distinguished only as far as an operator needs: whether the key is
 * missing is actionable, and everything else is deliberately one answer,
 * because telling an attacker which part of their forgery failed is a favour.
 *
 * What the bound account id buys, stated precisely because the temptation is to
 * read it as more: it stops a ciphertext being lifted from one account's row
 * into another's, which is the difference between one user's credential and
 * everybody's. It does **not** stop someone who can already write to the
 * database restoring an *earlier* ciphertext belonging to the same account, so
 * a token we have seen refused could be reinstated. Binding a version would
 * close that, at the cost of a column and a migration. It is not closed today,
 * and it should be before the hosted tier carries anyone's token but the
 * owner's.
 */
export async function openToken(
  keyring: Keyring,
  accountId: string,
  sealed: SealedToken,
): Promise<string> {
  const key = keyring.byId[sealed.keyId];
  if (key === undefined) {
    throw new CryptoError(
      `no key with id "${sealed.keyId}" is configured, so this row cannot be read`,
    );
  }

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: ALGORITHM,
        iv: decodeBase64(sealed.nonce),
        additionalData: new TextEncoder().encode(accountId),
      },
      key,
      decodeBase64(sealed.ciphertext),
    );
  } catch {
    throw new CryptoError("the stored token did not authenticate");
  }

  return new TextDecoder().decode(plaintext);
}

/**
 * Mints an account id.
 *
 * Here rather than in whatever onboarding code appears later, because two other
 * things silently depend on this value being unguessable and neither can check
 * it. It is the AES-GCM additional data above, so a predictable id weakens the
 * binding that keeps one user's ciphertext out of another's row. And
 * `accountTag` in `log.ts` hashes it to correlate log lines without naming an
 * account, which only holds while the input cannot be enumerated.
 *
 * `crypto.randomUUID` is 122 random bits from the platform CSPRNG. An email, a
 * sequence number, or anything derived from the user would break both
 * properties at once, which is exactly why minting is not left to a caller.
 */
export function newAccountId(): string {
  return crypto.randomUUID();
}

/**
 * Mints a screen key: the bearer capability a user pastes into TRMNL.
 *
 * 256 bits from the CSPRNG, base64url so it survives a URL and a form field
 * without escaping. It is shown to its owner once and never stored; only
 * `screenKeyFingerprint` of it goes in the database, so a leaked dump yields no
 * working keys.
 *
 * Deliberately not the account id. The id is authenticated as this token's
 * additional data, and a value the user carries around and pastes into a third
 * party's form is the last thing that should also be the value binding their
 * ciphertext to their row.
 */
export function newScreenKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * The stored form of a screen key: SHA-256, hex.
 *
 * A plain hash rather than a password KDF, and that is the right call here
 * rather than a shortcut. A KDF exists to make guessing a *low-entropy* secret
 * expensive. This secret is 256 random bits, so guessing is already impossible,
 * and a slow hash on a path TRMNL calls on every screen refresh would buy
 * nothing and cost latency on every request.
 */
export async function screenKeyFingerprint(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key.trim()));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Generates a key for an operator to paste into `wrangler secret put`.
 *
 * Here rather than in a script so that the one place keys are made is the same
 * place they are used, and so nobody is tempted to reach for `Math.random`.
 */
export async function generateKeyBase64(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: ALGORITHM, length: KEY_BITS }, true, [
    "encrypt",
  ]);
  return encodeBase64(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Base64 to bytes, backed by its own `ArrayBuffer`.
 *
 * The explicit buffer is not ceremony. Since TypeScript 5.7 `Uint8Array` is
 * generic over its backing store, and `BufferSource` — which every Web Crypto
 * call wants — accepts only a view over a real `ArrayBuffer`. A plain
 * `new Uint8Array(length)` infers the wider `ArrayBufferLike`, which TypeScript
 * 7 rejects at `importKey` and `decrypt` while 5.7 lets through. Allocating the
 * buffer here says what is true and compiles under both.
 */
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(value.trim());
  } catch {
    throw new CryptoError("a stored value is not valid base64");
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

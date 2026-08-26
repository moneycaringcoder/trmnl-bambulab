/**
 * Security contracts for hosted token encryption.
 *
 * Every credential-shaped value is generated at runtime. The suite contains no
 * captured token, key, account identifier, or ciphertext and never reaches a
 * network service.
 */

import { describe, expect, it } from "vitest";

import {
  CryptoError,
  generateKeyBase64,
  importKeyring,
  openToken,
  sealToken,
  type Keyring,
  type SealedToken,
} from "@trmnl-bambulab/core/hosted/crypto";

async function freshKeyring(id = "current"): Promise<{ encoded: string; keyring: Keyring }> {
  const encoded = await generateKeyBase64();
  return { encoded, keyring: await importKeyring({ [id]: encoded }, id) };
}

function accountId(suffix: string): string {
  return ["hosted-account", suffix, crypto.randomUUID()].join("-");
}

function plaintextCredential(): string {
  return ["opaque", "cloud", "credential", crypto.randomUUID()].join(".");
}

function tamper(sealed: SealedToken): SealedToken {
  const bytes = Uint8Array.from(atob(sealed.ciphertext), (character) => character.charCodeAt(0));
  const first = bytes[0];
  if (first === undefined) throw new Error("test ciphertext was unexpectedly empty");
  bytes[0] = first ^ 1;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { ...sealed, ciphertext: btoa(binary) };
}

describe("hosted token encryption", () => {
  it("round-trips a token for its account", async () => {
    const { keyring } = await freshKeyring();
    const owner = accountId("round-trip");
    const plaintext = plaintextCredential();

    const sealed = await sealToken(keyring, owner, plaintext);

    await expect(openToken(keyring, owner, sealed)).resolves.toBe(plaintext);
  });

  it("uses a fresh nonce for every seal", async () => {
    const { keyring } = await freshKeyring();
    const owner = accountId("nonce");
    const plaintext = plaintextCredential();

    const first = await sealToken(keyring, owner, plaintext);
    const second = await sealToken(keyring, owner, plaintext);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("binds ciphertext to the account id", async () => {
    const { keyring } = await freshKeyring();
    const sealed = await sealToken(keyring, accountId("owner"), plaintextCredential());

    await expect(openToken(keyring, accountId("other"), sealed)).rejects.toThrow(
      "did not authenticate",
    );
  });

  it("rejects a flipped ciphertext byte", async () => {
    const { keyring } = await freshKeyring();
    const owner = accountId("tamper");
    const sealed = await sealToken(keyring, owner, plaintextCredential());

    await expect(openToken(keyring, owner, tamper(sealed))).rejects.toThrow(
      "did not authenticate",
    );
  });

  it("explains that an unknown key id is missing", async () => {
    const { keyring } = await freshKeyring();
    const owner = accountId("unknown-key");
    const sealed = await sealToken(keyring, owner, plaintextCredential());
    const unreadable = { ...sealed, keyId: "missing" };

    await expect(openToken(keyring, owner, unreadable)).rejects.toThrow(CryptoError);
    await expect(openToken(keyring, owner, unreadable)).rejects.toThrow(/no key.*missing.*configured/);
  });

  it("opens old data with a retired key while new writes use the current key", async () => {
    const oldKey = await generateKeyBase64();
    const oldKeyring = await importKeyring({ old: oldKey }, "old");
    const owner = accountId("rotation");
    const plaintext = plaintextCredential();
    const oldSealed = await sealToken(oldKeyring, owner, plaintext);

    const currentKey = await generateKeyBase64();
    const rotated = await importKeyring({ old: oldKey, current: currentKey }, "current");
    const newSealed = await sealToken(rotated, owner, plaintext);

    await expect(openToken(rotated, owner, oldSealed)).resolves.toBe(plaintext);
    expect(newSealed.keyId).toBe("current");
  });

  it("never includes cryptographic material or plaintext in thrown messages", async () => {
    const { encoded, keyring } = await freshKeyring();
    const owner = accountId("error-redaction");
    const plaintext = plaintextCredential();
    const sealed = await sealToken(keyring, owner, plaintext);

    const errors = await Promise.all([
      openToken(keyring, accountId("wrong-owner"), sealed).catch((error: unknown) => error),
      openToken(keyring, owner, tamper(sealed)).catch((error: unknown) => error),
      openToken(keyring, owner, { ...sealed, keyId: "missing" }).catch(
        (error: unknown) => error,
      ),
    ]);

    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).not.toContain(plaintext);
      expect(message).not.toContain(encoded);
      expect(message).not.toContain(sealed.ciphertext);
    }
  });
});

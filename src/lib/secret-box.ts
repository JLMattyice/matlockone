import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Encryption for credentials the customer entrusts to the app.
 *
 * A mail password or an API key sitting in plain text inside a SQLite file is
 * a stolen-laptop problem: the file is readable by anything running as that
 * user, and it gets copied into every backup. These are encrypted with
 * AES-256-GCM under a key that lives outside the database.
 *
 * On the desktop build the launcher generates that key per installation and
 * passes it in, so one customer's backup is useless on another machine. On a
 * hosted deployment it comes from the environment.
 *
 * GCM is authenticated: a tampered ciphertext fails to decrypt rather than
 * silently yielding a different password.
 */

const KEY_INFO = "fieldbase:integration-credentials:v1";

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      "Credential storage is not configured. Set ENCRYPTION_KEY before saving connection details.",
    );
    this.name = "EncryptionUnavailableError";
  }
}

/** True when credentials can be stored at all. Screens check this first. */
export function encryptionAvailable() {
  const key = process.env.ENCRYPTION_KEY;
  return typeof key === "string" && key.length >= 32;
}

function derivedKey() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new EncryptionUnavailableError();

  // HKDF gives a uniform 32-byte key from whatever the environment supplied,
  // and domain-separates this use from any other use of the same secret.
  return Buffer.from(hkdfSync("sha256", secret, "", KEY_INFO, 32));
}

export type SealedSecret = {
  cipherText: string;
  nonce: string;
  tag: string;
};

export function seal(plainText: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(), iv);

  const cipherText = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);

  return {
    cipherText: cipherText.toString("base64"),
    nonce: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Returns null rather than throwing when the stored value cannot be read. */
export function open(sealed: Partial<SealedSecret> | null | undefined) {
  if (!sealed?.cipherText || !sealed.nonce || !sealed.tag) return null;

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derivedKey(),
      Buffer.from(sealed.nonce, "base64"),
    );
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(sealed.cipherText, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, or the row was tampered with. Either way the caller must
    // treat the credential as unusable rather than guessing.
    return null;
  }
}

/** For showing that something is stored without revealing it. */
export function maskSecret(value: string) {
  if (value.length <= 4) return "••••";
  return `${"•".repeat(Math.min(value.length - 4, 20))}${value.slice(-4)}`;
}

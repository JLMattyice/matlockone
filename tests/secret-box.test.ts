import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  encryptionAvailable,
  EncryptionUnavailableError,
  maskSecret,
  open,
  seal,
} from "@/lib/secret-box";

const KEY = "0123456789abcdef0123456789abcdef";
const OTHER_KEY = "fedcba9876543210fedcba9876543210";

describe("secret-box", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = KEY;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = original;
  });

  it("round-trips a mail password", () => {
    const sealed = seal("hunter2-app-password");
    expect(open(sealed)).toBe("hunter2-app-password");
  });

  it("never stores the plain text", () => {
    const sealed = seal("hunter2-app-password");

    for (const part of Object.values(sealed)) {
      expect(part).not.toContain("hunter2");
    }
  });

  it("produces different ciphertext each time", () => {
    // A fresh nonce per seal, so two accounts with the same password do not
    // produce identical rows.
    const a = seal("same-password");
    const b = seal("same-password");

    expect(a.cipherText).not.toBe(b.cipherText);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("will not open with a different installation's key", () => {
    const sealed = seal("hunter2-app-password");

    process.env.ENCRYPTION_KEY = OTHER_KEY;
    expect(open(sealed)).toBeNull();
  });

  it("rejects a tampered ciphertext rather than returning garbage", () => {
    const sealed = seal("hunter2-app-password");
    const bytes = Buffer.from(sealed.cipherText, "base64");
    bytes[0] ^= 0xff;

    expect(open({ ...sealed, cipherText: bytes.toString("base64") })).toBeNull();
  });

  it("treats a half-written row as unusable", () => {
    const sealed = seal("hunter2-app-password");

    expect(open(null)).toBeNull();
    expect(open({ cipherText: sealed.cipherText })).toBeNull();
    expect(open({ ...sealed, tag: undefined })).toBeNull();
  });

  it("refuses to seal without a key, instead of storing plain text", () => {
    delete process.env.ENCRYPTION_KEY;

    expect(encryptionAvailable()).toBe(false);
    expect(() => seal("hunter2")).toThrow(EncryptionUnavailableError);
  });

  it("treats a too-short key as no key at all", () => {
    process.env.ENCRYPTION_KEY = "short";

    expect(encryptionAvailable()).toBe(false);
    expect(() => seal("hunter2")).toThrow(EncryptionUnavailableError);
  });

  it("masks everything but the last four characters", () => {
    expect(maskSecret("re_abcdefgh1234")).toMatch(/^•+1234$/);
    expect(maskSecret("abc")).toBe("••••");
  });
});

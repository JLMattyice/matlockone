import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

/**
 * Licence tokens.
 *
 * A licence is a signed statement, not a key to look up. Everything the app
 * needs — plan, seats, expiry, who it belongs to — travels inside the token, so
 * a machine with no internet can still answer "may this run, and for how many
 * people". That is not a convenience: the desktop build is sold on the promise
 * that a customer's data never leaves their office, and a licence check that
 * phoned home would be the one thing that did.
 *
 *   MO1.<base64url payload>.<base64url signature>
 *
 * Ed25519 from Node's standard library, for the same reason passwords use
 * scrypt from it: no native module to compile, nothing to keep in step with an
 * Electron ABI.
 *
 * What this cannot do, stated plainly: the verifying key ships inside the
 * application, so someone determined can patch the check out of their own copy.
 * Offline licensing raises the cost of casual copying. It does not make it
 * impossible, and no scheme that works without a server does.
 */

export const TOKEN_PREFIX = "MO1";
export const LICENSE_VERSION = 1;

export const LICENSE_PLANS = ["starter", "business", "pro"] as const;
export type LicensePlan = (typeof LICENSE_PLANS)[number];

/** `demo` is the same build with the limits turned on, never a second binary. */
export const LICENSE_MODES = ["paid", "demo"] as const;
export type LicenseMode = (typeof LICENSE_MODES)[number];

export type LicenseClaims = {
  /** Format version. A token from a future version is refused, not guessed at. */
  v: number;
  /** Unique id for this licence, so one can be named in a revocation list later. */
  id: string;
  /** Who it was issued to. Shown in the app so a shared key is at least visible. */
  sub: string;
  /** The business name, for display. */
  org?: string;
  plan: LicensePlan;
  mode: LicenseMode;
  /** Active users allowed, or null for unlimited. */
  seats: number | null;
  /** Issued at, seconds since epoch. */
  iat: number;
  /** Not valid before, seconds since epoch. Optional. */
  nbf?: number;
  /** Expires at, seconds since epoch. The end of the paid period. */
  exp: number;
};

export type VerifyFailure =
  | "malformed"
  | "unsupported-version"
  | "bad-signature"
  | "not-yet-valid"
  | "expired";

export type VerifyResult =
  | { ok: true; license: LicenseClaims }
  | { ok: false; reason: VerifyFailure; message: string };

// ------------------------------------------------------------- base64url ---

function toBase64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// ------------------------------------------------------------------ sign ---

/**
 * The signature covers the encoded payload segment exactly as it appears in the
 * token — not a re-serialised copy of the claims.
 *
 * Re-serialising would make the signature depend on key order and whitespace,
 * so a verifier that stringified differently from the signer would reject a
 * perfectly good licence. Signing the bytes that actually travel removes the
 * question.
 */
function signingInput(payloadSegment: string): Buffer {
  return Buffer.from(payloadSegment, "ascii");
}

export function issueLicense(
  claims: Omit<LicenseClaims, "v">,
  privateKey: KeyObject | string,
): string {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const payload: LicenseClaims = { v: LICENSE_VERSION, ...claims };

  const segment = toBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = sign(null, signingInput(segment), key);

  return `${TOKEN_PREFIX}.${segment}.${toBase64Url(signature)}`;
}

// ---------------------------------------------------------------- verify ---

function fail(reason: VerifyFailure, message: string): VerifyResult {
  return { ok: false, reason, message };
}

/**
 * Order matters here: the signature is checked before any claim is read.
 *
 * Reading `exp` or `plan` from an unverified payload and acting on it — even to
 * produce a nicer error — is how a forged token gets a foothold. Nothing in the
 * payload is trusted until the bytes are proven to come from the private key.
 */
export function verifyLicense(
  token: string,
  publicKey: KeyObject | string,
  now: Date = new Date(),
): VerifyResult {
  if (typeof token !== "string" || token.length === 0) {
    return fail("malformed", "No licence key was supplied.");
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return fail("malformed", "That does not look like a Matlock One licence key.");
  }

  const [, segment, signatureSegment] = parts;

  let verified = false;
  try {
    const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
    verified = verify(null, signingInput(segment), key, fromBase64Url(signatureSegment));
  } catch {
    // A malformed signature or key throws rather than returning false.
    return fail("bad-signature", "This licence key could not be verified.");
  }

  if (!verified) {
    return fail("bad-signature", "This licence key could not be verified.");
  }

  let claims: LicenseClaims;
  try {
    claims = JSON.parse(fromBase64Url(segment).toString("utf8")) as LicenseClaims;
  } catch {
    return fail("malformed", "This licence key is damaged.");
  }

  if (!isWellFormed(claims)) {
    return fail("malformed", "This licence key is damaged.");
  }

  // A signed token from a newer format is refused rather than half-understood:
  // guessing at claims this build does not know could grant more than it should.
  if (claims.v !== LICENSE_VERSION) {
    return fail(
      "unsupported-version",
      "This licence needs a newer version of Matlock One.",
    );
  }

  const seconds = Math.floor(now.getTime() / 1000);

  if (typeof claims.nbf === "number" && seconds < claims.nbf) {
    return fail("not-yet-valid", "This licence has not started yet.");
  }

  if (seconds >= claims.exp) {
    return fail("expired", "This licence has expired.");
  }

  return { ok: true, license: claims };
}

function isWellFormed(claims: unknown): claims is LicenseClaims {
  if (typeof claims !== "object" || claims === null) return false;
  const c = claims as Record<string, unknown>;

  return (
    typeof c.v === "number" &&
    typeof c.id === "string" &&
    c.id.length > 0 &&
    typeof c.sub === "string" &&
    c.sub.length > 0 &&
    typeof c.plan === "string" &&
    (LICENSE_PLANS as readonly string[]).includes(c.plan) &&
    typeof c.mode === "string" &&
    (LICENSE_MODES as readonly string[]).includes(c.mode) &&
    (c.seats === null || (typeof c.seats === "number" && Number.isInteger(c.seats) && c.seats > 0)) &&
    typeof c.iat === "number" &&
    typeof c.exp === "number" &&
    (c.nbf === undefined || typeof c.nbf === "number") &&
    (c.org === undefined || typeof c.org === "string")
  );
}

/** True when `count` active users is within what the licence allows. */
export function seatsAllow(license: LicenseClaims, count: number): boolean {
  return license.seats === null || count <= license.seats;
}

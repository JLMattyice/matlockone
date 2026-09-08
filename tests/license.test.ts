import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  TOKEN_PREFIX,
  issueLicense,
  seatsAllow,
  verifyLicense,
  type LicenseClaims,
} from "../src/lib/license/token";

/**
 * Licences decide whether software someone paid for will run. A hole here is
 * either revenue walking out the door or a paying customer locked out of their
 * own business on a Monday morning, and neither announces itself.
 */

const keys = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");

const HOUR = 3600;
const now = new Date("2026-09-07T12:00:00Z");
const seconds = Math.floor(now.getTime() / 1000);

function claims(overrides: Partial<Omit<LicenseClaims, "v">> = {}) {
  return {
    id: "lic_test",
    sub: "owner@example.com",
    plan: "business" as const,
    mode: "paid" as const,
    seats: 10,
    iat: seconds - HOUR,
    exp: seconds + HOUR,
    ...overrides,
  };
}

function toBase64Url(input: Buffer) {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Signs arbitrary claims, including shapes `issueLicense` would never produce. */
function forge(payload: unknown, key = keys.privateKey) {
  const segment = toBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = sign(null, Buffer.from(segment, "ascii"), key);
  return `${TOKEN_PREFIX}.${segment}.${toBase64Url(signature)}`;
}

describe("issuing and verifying", () => {
  it("accepts a licence it just issued", () => {
    const token = issueLicense(claims(), keys.privateKey);
    const result = verifyLicense(token, keys.publicKey, now);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.license.sub).toBe("owner@example.com");
    expect(result.license.plan).toBe("business");
    expect(result.license.seats).toBe(10);
    expect(result.license.v).toBe(1);
  });

  it("carries the optional business name through", () => {
    const token = issueLicense(claims({ org: "Ridgeline Plumbing" }), keys.privateKey);
    const result = verifyLicense(token, keys.publicKey, now);

    expect(result.ok && result.license.org).toBe("Ridgeline Plumbing");
  });

  it("accepts a PEM string as well as a key object", () => {
    const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

    const result = verifyLicense(issueLicense(claims(), pem), publicPem, now);
    expect(result.ok).toBe(true);
  });
});

describe("forgery", () => {
  it("rejects an edited payload", () => {
    // The whole point: upgrade yourself to unlimited seats and it stops working.
    const token = issueLicense(claims({ seats: 1 }), keys.privateKey);
    const [prefix, , signature] = token.split(".");
    const swapped = toBase64Url(
      Buffer.from(JSON.stringify({ ...claims({ seats: null }), v: 1 }), "utf8"),
    );

    const result = verifyLicense(`${prefix}.${swapped}.${signature}`, keys.publicKey, now);
    expect(result).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("rejects an edited signature", () => {
    const token = issueLicense(claims(), keys.privateKey);
    const [prefix, payload, signature] = token.split(".");
    const flipped = `${signature.slice(0, -2)}${signature.slice(-2) === "AA" ? "AB" : "AA"}`;

    const result = verifyLicense(`${prefix}.${payload}.${flipped}`, keys.publicKey, now);
    expect(result).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("rejects a licence signed by somebody else's key", () => {
    const token = issueLicense(claims(), other.privateKey);
    const result = verifyLicense(token, keys.publicKey, now);

    expect(result).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("rejects an unsigned token whose claims look generous", () => {
    const payload = toBase64Url(
      Buffer.from(JSON.stringify({ ...claims({ seats: null }), v: 1 }), "utf8"),
    );
    const result = verifyLicense(`${TOKEN_PREFIX}.${payload}.`, keys.publicKey, now);

    expect(result.ok).toBe(false);
  });
});

describe("the calendar", () => {
  it("rejects an expired licence", () => {
    const token = issueLicense(claims({ exp: seconds - 1 }), keys.privateKey);
    expect(verifyLicense(token, keys.publicKey, now)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("treats the expiry second itself as expired", () => {
    const token = issueLicense(claims({ exp: seconds }), keys.privateKey);
    expect(verifyLicense(token, keys.publicKey, now)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a licence that has not started", () => {
    const token = issueLicense(claims({ nbf: seconds + HOUR }), keys.privateKey);
    expect(verifyLicense(token, keys.publicKey, now)).toMatchObject({
      ok: false,
      reason: "not-yet-valid",
    });
  });

  it("accepts one that started in the past and runs into the future", () => {
    const token = issueLicense(
      claims({ nbf: seconds - HOUR, exp: seconds + HOUR }),
      keys.privateKey,
    );
    expect(verifyLicense(token, keys.publicKey, now).ok).toBe(true);
  });
});

describe("damaged and hostile input", () => {
  it.each([
    ["empty", ""],
    ["not a token", "hello"],
    ["wrong prefix", "JWT.abc.def"],
    ["too few parts", "MO1.abc"],
    ["too many parts", "MO1.a.b.c"],
  ])("rejects %s", (_label, token) => {
    expect(verifyLicense(token, keys.publicKey, now)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a signed token whose payload is not a licence", () => {
    expect(verifyLicense(forge({ hello: "world" }), keys.publicKey, now)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a signed token with an unknown plan", () => {
    const result = verifyLicense(forge({ ...claims(), v: 1, plan: "enterprise" }), keys.publicKey, now);
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("rejects a signed token with fractional or negative seats", () => {
    expect(verifyLicense(forge({ ...claims(), v: 1, seats: 2.5 }), keys.publicKey, now).ok).toBe(false);
    expect(verifyLicense(forge({ ...claims(), v: 1, seats: -1 }), keys.publicKey, now).ok).toBe(false);
    expect(verifyLicense(forge({ ...claims(), v: 1, seats: 0 }), keys.publicKey, now).ok).toBe(false);
  });

  it("refuses a validly signed licence from a newer format", () => {
    // Better to tell someone to update than to guess at claims this build does
    // not understand and grant more than was paid for.
    const result = verifyLicense(forge({ ...claims(), v: 2 }), keys.publicKey, now);
    expect(result).toMatchObject({ ok: false, reason: "unsupported-version" });
  });
});

describe("seats", () => {
  const license = (seats: number | null) => ({ ...claims({ seats }), v: 1 }) as LicenseClaims;

  it("allows a count up to the limit", () => {
    expect(seatsAllow(license(10), 9)).toBe(true);
    expect(seatsAllow(license(10), 10)).toBe(true);
  });

  it("refuses one past the limit", () => {
    expect(seatsAllow(license(10), 11)).toBe(false);
    expect(seatsAllow(license(1), 2)).toBe(false);
  });

  it("treats null as unlimited", () => {
    expect(seatsAllow(license(null), 5000)).toBe(true);
  });
});

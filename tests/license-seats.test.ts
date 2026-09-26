import { generateKeyPairSync } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import {
  DEMO_SEATS,
  daysRemaining,
  licenseState,
  licenseSummary,
} from "../src/lib/license/status";
import { issueLicense, type LicensePlan } from "../src/lib/license/token";

/**
 * Seat limits, and the states a workspace can be in.
 *
 * What a key is worth: its plan and seats, or why it is not valid. Whether the
 * business is open is decided by entitlement, which billing-entitlement.test.ts
 * covers, seat checks included.
 */

const keys = generateKeyPairSync("ed25519");
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

/*
 * The module reads the verifying key at call time, so the test supplies its own
 * rather than depending on a signing key that is deliberately not in the repo.
 *
 * Set at module scope, not in beforeAll: vitest evaluates every `describe` body
 * during collection, before any hook runs, and the states built there would
 * otherwise be resolved against the real embedded key and come back as demo.
 */
const original = process.env.LICENSE_PUBLIC_KEY;
process.env.LICENSE_PUBLIC_KEY = publicPem;

afterAll(() => {
  process.env.LICENSE_PUBLIC_KEY = original;
});

const now = new Date("2026-09-07T12:00:00Z");
const seconds = Math.floor(now.getTime() / 1000);
const DAY = 86_400;

function key(
  overrides: {
    plan?: LicensePlan;
    seats?: number | null;
    exp?: number;
    mode?: "paid" | "demo";
  } = {},
) {
  return issueLicense(
    {
      id: "lic_seat_test",
      sub: "owner@example.com",
      plan: overrides.plan ?? "business",
      mode: overrides.mode ?? "paid",
      seats: overrides.seats === undefined ? 10 : overrides.seats,
      iat: seconds - DAY,
      exp: overrides.exp ?? seconds + 30 * DAY,
    },
    keys.privateKey,
  );
}

describe("resolving a workspace's licence", () => {
  it("treats no key as demo mode", () => {
    const state = licenseState(null, now);
    expect(state).toMatchObject({ kind: "demo", seats: DEMO_SEATS });
    expect(state.kind === "demo" && state.reason).toBeUndefined();
  });

  it("treats an empty or whitespace key as demo mode", () => {
    expect(licenseState("", now).kind).toBe("demo");
    expect(licenseState("   ", now).kind).toBe("demo");
  });

  it("reads seats from a valid licence", () => {
    const state = licenseState(key({ seats: 10 }), now);
    expect(state).toMatchObject({ kind: "licensed", seats: 10 });
  });

  it("carries unlimited seats through as null", () => {
    const state = licenseState(key({ plan: "pro", seats: null }), now);
    expect(state).toMatchObject({ kind: "licensed", seats: null });
  });

  it("degrades an expired licence to demo, and says why", () => {
    const state = licenseState(key({ exp: seconds - DAY }), now);
    expect(state).toMatchObject({
      kind: "demo",
      reason: "expired",
      seats: DEMO_SEATS,
    });
  });

  it("degrades a damaged key to demo rather than throwing", () => {
    // A corrupted licence must never take the business's own records down.
    expect(() => licenseState("not-a-licence", now)).not.toThrow();
    expect(licenseState("not-a-licence", now)).toMatchObject({
      kind: "demo",
      reason: "malformed",
    });
  });

  it("degrades a licence signed by another key to demo", () => {
    const other = generateKeyPairSync("ed25519");
    const foreign = issueLicense(
      {
        id: "lic_foreign",
        sub: "someone@example.com",
        plan: "pro",
        mode: "paid",
        seats: null,
        iat: seconds,
        exp: seconds + DAY,
      },
      other.privateKey,
    );

    expect(licenseState(foreign, now)).toMatchObject({
      kind: "demo",
      reason: "bad-signature",
    });
  });
});

describe("what the screen says", () => {
  it("summarises a paid licence with its plan and seats", () => {
    expect(licenseSummary(licenseState(key({ seats: 10 }), now))).toBe(
      "Business · 10 people",
    );
  });

  it("says unlimited rather than a number", () => {
    expect(
      licenseSummary(licenseState(key({ plan: "pro", seats: null }), now)),
    ).toBe("Pro · unlimited people");
  });

  it("uses the singular for a one-person plan", () => {
    expect(
      licenseSummary(licenseState(key({ plan: "starter", seats: 1 }), now)),
    ).toBe("Starter · 1 person");
  });

  it("distinguishes never-licensed from expired", () => {
    expect(licenseSummary(licenseState(null, now))).toBe("No licence");
    expect(licenseSummary(licenseState(key({ exp: seconds - DAY }), now))).toBe(
      "Licence expired",
    );
  });

  it("counts the days to renewal, and nothing when unlicensed", () => {
    expect(daysRemaining(licenseState(key({ exp: seconds + 10 * DAY }), now), now)).toBe(10);
    expect(daysRemaining(licenseState(null, now), now)).toBeNull();
  });
});

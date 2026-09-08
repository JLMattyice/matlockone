import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { fulfilPurchase, purchasesFor } from "@/lib/checkout/fulfil";
import {
  ANNUAL_DISCOUNT_BP,
  PLANS,
  annualCents,
  formatPrice,
  isPlan,
  planList,
  priceCents,
} from "@/lib/checkout/plans";
import {
  CHECKOUT_PROVIDER_META,
  availableCheckoutProviders,
} from "@/lib/checkout/providers";
import { prisma } from "@/lib/db";
import { verifyLicense } from "@/lib/license/token";

/**
 * Fulfilment, against the real database — because the guarantee under test is a
 * database constraint, not a branch. Every processor retries; if a retry could
 * mint a second licence, a customer would hold two keys with different expiry
 * dates and the one they pasted would decide their seat limit by luck.
 */

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

const now = new Date("2026-09-07T12:00:00Z");

let counter = 0;
const ref = () => `test-ref-${(counter += 1)}-${Date.now()}`;

beforeEach(async () => {
  await prisma.purchase.deleteMany({});
});

describe("fulfilling a sale", () => {
  it("records the purchase and issues a licence that verifies", async () => {
    const result = await fulfilPurchase(
      {
        provider: "MANUAL",
        externalId: ref(),
        email: "Owner@Example.com",
        orgName: "Ridgeline Plumbing",
        plan: "business",
      },
      { privateKey, now },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.reissued).toBe(false);
    // Addresses are normalised, so a customer is one customer however they typed it.
    expect(result.purchase.email).toBe("owner@example.com");

    const verified = verifyLicense(result.licenseKey, publicKey, now);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    expect(verified.license.plan).toBe("business");
    expect(verified.license.seats).toBe(10);
    expect(verified.license.mode).toBe("paid");
    expect(verified.license.org).toBe("Ridgeline Plumbing");
  });

  it("takes seats and price from the plan the customer bought", async () => {
    const result = await fulfilPurchase(
      { provider: "MANUAL", externalId: ref(), email: "a@b.com", plan: "pro" },
      { privateKey, now },
    );

    expect(result.ok && result.purchase.seats).toBeNull();
    expect(result.ok && result.purchase.amountCents).toBe(
      annualCents(PLANS.pro),
    );
  });

  it("honours a negotiated seat count over the plan's own", async () => {
    const result = await fulfilPurchase(
      {
        provider: "MANUAL",
        externalId: ref(),
        email: "a@b.com",
        plan: "business",
        seats: 25,
      },
      { privateKey, now },
    );

    expect(result.ok && result.purchase.seats).toBe(25);
  });

  it("expires the licence at the end of the term", async () => {
    const result = await fulfilPurchase(
      {
        provider: "MANUAL",
        externalId: ref(),
        email: "a@b.com",
        plan: "starter",
        months: 1,
      },
      { privateKey, now },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verified = verifyLicense(result.licenseKey, publicKey, now);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    // One calendar month on: bought on the 7th, ends on the 7th.
    expect(new Date(verified.license.exp * 1000).toISOString().slice(0, 10)).toBe(
      "2026-10-07",
    );
  });
});

describe("the same sale arriving twice", () => {
  it("returns the licence already issued rather than a second one", async () => {
    const externalId = ref();
    const input = {
      provider: "PAYPAL",
      externalId,
      email: "a@b.com",
      plan: "business" as const,
    };

    const first = await fulfilPurchase(input, { privateKey, now });
    const second = await fulfilPurchase(input, { privateKey, now });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.reissued).toBe(true);
    expect(second.licenseKey).toBe(first.licenseKey);
    expect(second.purchase.id).toBe(first.purchase.id);

    expect(await prisma.purchase.count({ where: { externalId } })).toBe(1);
  });

  it("survives two webhooks landing at the same moment", async () => {
    // Both miss the existing-purchase read, so one loses on the unique index.
    // The loser must return the winner's licence, not crash and not sign again.
    const externalId = ref();
    const input = {
      provider: "PAYPAL",
      externalId,
      email: "a@b.com",
      plan: "pro" as const,
    };

    const [a, b] = await Promise.all([
      fulfilPurchase(input, { privateKey, now }),
      fulfilPurchase(input, { privateKey, now }),
    ]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.licenseKey).toBe(b.licenseKey);
    expect(await prisma.purchase.count({ where: { externalId } })).toBe(1);
  });

  it("keeps the same id two different processors both reported", async () => {
    // A shared reference across processors is two sales, not one.
    const externalId = ref();
    await fulfilPurchase(
      { provider: "PAYPAL", externalId, email: "a@b.com", plan: "starter" },
      { privateKey, now },
    );
    await fulfilPurchase(
      { provider: "STRIPE", externalId, email: "a@b.com", plan: "starter" },
      { privateKey, now },
    );

    expect(await prisma.purchase.count({ where: { externalId } })).toBe(2);
  });
});

describe("refusing what cannot be fulfilled", () => {
  it("refuses an unknown plan", async () => {
    const result = await fulfilPurchase(
      // @ts-expect-error — a webhook can carry anything.
      { provider: "MANUAL", externalId: ref(), email: "a@b.com", plan: "enterprise" },
      { privateKey, now },
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("refuses an address that is not one", async () => {
    const result = await fulfilPurchase(
      { provider: "MANUAL", externalId: ref(), email: "nope", plan: "business" },
      { privateKey, now },
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a sale with no processor reference", async () => {
    // Without one there is no idempotency key, so a retry would sell twice.
    const result = await fulfilPurchase(
      { provider: "MANUAL", externalId: "  ", email: "a@b.com", plan: "business" },
      { privateKey, now },
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("records nothing when there is no signing key", async () => {
    const externalId = ref();
    const result = await fulfilPurchase(
      { provider: "MANUAL", externalId, email: "a@b.com", plan: "business" },
      { privateKey: "", now },
    );

    expect(result.ok).toBe(false);
    // Crucially the row is absent: a purchase written without a licence would
    // be permanently un-fulfillable behind its own idempotency key.
    expect(await prisma.purchase.count({ where: { externalId } })).toBe(0);
  });
});

describe("looking a customer up", () => {
  it("finds what an address bought, however it was capitalised", async () => {
    await fulfilPurchase(
      { provider: "MANUAL", externalId: ref(), email: "Lane@Example.com", plan: "pro" },
      { privateKey, now },
    );

    expect(await purchasesFor("lane@example.com")).toHaveLength(1);
    expect(await purchasesFor("  LANE@EXAMPLE.COM ")).toHaveLength(1);
  });
});

describe("the price list", () => {
  it("charges the advertised monthly price", () => {
    expect(PLANS.starter.monthlyCents).toBe(2_900);
    expect(PLANS.business.monthlyCents).toBe(5_900);
    expect(PLANS.pro.monthlyCents).toBe(9_900);
  });

  it("never gives away less discount than it advertises", () => {
    for (const plan of planList()) {
      const full = plan.monthlyCents * 12;
      const discount = full - annualCents(plan);
      expect(discount / full).toBeGreaterThanOrEqual(ANNUAL_DISCOUNT_BP / 10_000);
    }
  });

  it("charges the plain multiple for any other term", () => {
    expect(priceCents(PLANS.business, 3)).toBe(5_900 * 3);
    expect(priceCents(PLANS.business, 12)).toBe(annualCents(PLANS.business));
  });

  it("drops the cents only when there are none", () => {
    expect(formatPrice(2_900)).toBe("$29");
    expect(formatPrice(28_836)).toBe("$288.36");
  });

  it("recognises exactly the plans a licence can carry", () => {
    expect(isPlan("business")).toBe(true);
    expect(isPlan("enterprise")).toBe(false);
    expect(isPlan(null)).toBe(false);
  });
});

describe("checkout providers", () => {
  it("offers none it has no adapter for", () => {
    // The same rule the payment catalog holds: a button that takes money and
    // issues nothing is worse than no button.
    for (const provider of availableCheckoutProviders()) {
      expect(provider.implemented).toBe(true);
    }

    expect(CHECKOUT_PROVIDER_META.STRIPE.implemented).toBe(false);
  });

  it("explains why an unbuilt provider is unavailable", () => {
    for (const meta of Object.values(CHECKOUT_PROVIDER_META)) {
      if (!meta.implemented) expect(meta.note).toBeTruthy();
    }
  });
});

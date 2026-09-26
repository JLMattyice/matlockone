import { generateKeyPairSync } from "node:crypto";

import { format } from "date-fns";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";

import { BillingBanner } from "@/components/app-shell/billing-banner";
import {
  canAddPerson,
  entitlement,
  GRACE_DAYS,
  type BillingFields,
} from "@/lib/billing/entitlement";
import { issueLicense } from "@/lib/license/token";

/**
 * Who is open, and who is not.
 *
 * There is no free tier. The rules worth pinning are the ones a mistake would
 * cost somebody for: a business that has paid is never shut out a day early,
 * a business that has not is never let in, the demo and an exempt business
 * never lock at all, and a payment PayPal is still retrying gets its grace
 * days rather than a closed door.
 */

const keys = generateKeyPairSync("ed25519");
const original = process.env.LICENSE_PUBLIC_KEY;
process.env.LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
afterAll(() => {
  process.env.LICENSE_PUBLIC_KEY = original;
});

const now = new Date("2026-09-27T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const days = (n: number) => new Date(now.getTime() + n * DAY_MS);

const UNPAID: BillingFields = {
  isDemo: false,
  billingExempt: false,
  licenseKey: null,
  subscriptionStatus: null,
  subscriptionPlan: null,
  paidThrough: null,
};

const paid = (fields: Partial<BillingFields> = {}): BillingFields => ({
  ...UNPAID,
  subscriptionStatus: "ACTIVE",
  subscriptionPlan: "business",
  paidThrough: days(20),
  ...fields,
});

function licence(expiresInDays: number, seats: number | null = 10) {
  const seconds = Math.floor(now.getTime() / 1000);
  return issueLicense(
    {
      id: "lic_billing_test",
      sub: "owner@example.com",
      plan: "business",
      mode: "paid",
      seats,
      iat: seconds - 86_400,
      exp: seconds + expiresInDays * 86_400,
    },
    keys.privateKey,
  );
}

describe("entitlement", () => {
  it("shuts a business that has never paid", () => {
    expect(entitlement(UNPAID, now)).toEqual({ ok: false, reason: "never-paid" });
  });

  it("opens a business paid up to a date still ahead", () => {
    expect(entitlement(paid(), now)).toEqual({
      ok: true,
      via: "subscription",
      plan: "business",
      seats: 10,
    });
  });

  it("keeps a business open through its grace days, and not a moment after", () => {
    // PayPal retries a failed payment over several days. Closing the account
    // on the first miss would lock out a business whose card simply expired.
    expect(entitlement(paid({ paidThrough: days(-1) }), now).ok).toBe(true);
    expect(entitlement(paid({ paidThrough: days(-GRACE_DAYS + 0.01) }), now).ok).toBe(true);
    expect(entitlement(paid({ paidThrough: days(-GRACE_DAYS) }), now)).toEqual({
      ok: false,
      reason: "lapsed",
    });
  });

  it("keeps a cancelled plan open to the end of what it paid for", () => {
    const cancelled = paid({ subscriptionStatus: "CANCELLED", paidThrough: days(5) });
    expect(entitlement(cancelled, now).ok).toBe(true);
    expect(entitlement(cancelled, days(5 + GRACE_DAYS)).ok).toBe(false);
  });

  it("goes by the date, not by what PayPal last called the subscription", () => {
    // Status only ever moves paidThrough forward when ACTIVE (subscription.ts),
    // so the date alone is the answer here.
    expect(entitlement(paid({ subscriptionStatus: "SUSPENDED" }), now).ok).toBe(true);
    expect(entitlement(paid({ subscriptionStatus: "ACTIVE", paidThrough: days(-30) }), now).ok).toBe(
      false,
    );
  });

  it("does not open on a date with no plan it can name", () => {
    expect(entitlement(paid({ subscriptionPlan: null }), now).ok).toBe(false);
    expect(entitlement(paid({ subscriptionPlan: "enterprise" }), now).ok).toBe(false);
  });

  it("never locks the demo, paid or not", () => {
    expect(entitlement({ ...UNPAID, isDemo: true }, now)).toMatchObject({ ok: true, via: "demo" });
    expect(
      entitlement({ ...paid({ paidThrough: days(-400) }), isDemo: true }, now),
    ).toMatchObject({ ok: true, via: "demo" });
  });

  it("never locks an exempt business, and caps nobody in it", () => {
    expect(entitlement({ ...UNPAID, billingExempt: true }, now)).toEqual({
      ok: true,
      via: "exempt",
      plan: null,
      seats: null,
    });
  });

  it("opens on a valid licence key, with that key's seats", () => {
    expect(entitlement({ ...UNPAID, licenseKey: licence(30, 4) }, now)).toMatchObject({
      ok: true,
      via: "licence",
      seats: 4,
    });
  });

  it("calls an expired licence lapsed, not never-paid", () => {
    expect(entitlement({ ...UNPAID, licenseKey: licence(-1) }, now)).toEqual({
      ok: false,
      reason: "lapsed",
    });
    expect(entitlement({ ...UNPAID, licenseKey: "not-a-key" }, now)).toMatchObject({ ok: false });
  });
});

describe("adding a person", () => {
  const business = entitlement(paid(), now);
  const pro = entitlement(paid({ subscriptionPlan: "pro" }), now);
  const starter = entitlement(paid({ subscriptionPlan: "starter" }), now);

  it("allows one below the plan's seats and refuses one at them", () => {
    expect(canAddPerson(business, 9).ok).toBe(true);
    expect(canAddPerson(business, 10).ok).toBe(false);
    expect(canAddPerson(business, 14).ok).toBe(false);
  });

  it("never refuses on an unlimited plan or an exempt business", () => {
    expect(canAddPerson(pro, 5000).ok).toBe(true);
    expect(canAddPerson(entitlement({ ...UNPAID, billingExempt: true }, now), 5000).ok).toBe(true);
  });

  it("explains the refusal in terms the person can act on", () => {
    const refused = canAddPerson(starter, 1);
    expect(refused).toEqual({
      ok: false,
      limit: 1,
      active: 1,
      message:
        "The Starter plan covers 1 person, and you have 1 active. Move to a larger plan, or deactivate someone first.",
    });
  });

  it("is a check on the step, so a business over its seats keeps everyone it has", () => {
    // Moving to a smaller plan stops the next addition. Nothing here says
    // anything about the eight people already working.
    const refused = canAddPerson(starter, 8);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.active).toBe(8);
  });
});

describe("the billing banner", () => {
  // The banner reads the real clock, so these dates are counted from it.
  const soon = new Date(Date.now() + 10 * DAY_MS);
  const current = (fields: Partial<BillingFields>) => paid({ paidThrough: soon, ...fields });

  const render = (org: BillingFields, canManage = true) =>
    renderToStaticMarkup(createElement(BillingBanner, { org, canManage }));

  it("says nothing to a business that is paid up and renewing", () => {
    expect(render(current({}))).toBe("");
  });

  it("says nothing to the demo or an exempt business", () => {
    expect(render({ ...UNPAID, isDemo: true })).toBe("");
    expect(render({ ...UNPAID, billingExempt: true })).toBe("");
  });

  it("tells a cancelled business the day it closes", () => {
    const html = render(current({ subscriptionStatus: "CANCELLED" }));
    expect(html).toContain(
      `Your plan is cancelled and stays open until ${format(soon, "MMMM d")}.`,
    );
    expect(html).toContain('href="/billing"');
  });

  it("tells a business with a failed payment how long it has", () => {
    const html = render(current({ subscriptionStatus: "SUSPENDED" }));
    expect(html).toContain("PayPal couldn’t take your last payment");
    // The deadline is the grace days' end, not the paid-through date.
    const deadline = new Date(soon.getTime() + GRACE_DAYS * DAY_MS);
    expect(html).toContain(`before ${format(deadline, "MMMM d")}`);
  });

  it("says nothing once a plan has closed: that business is on the billing page", () => {
    expect(render(paid({ paidThrough: new Date(Date.now() - 30 * DAY_MS) }))).toBe("");
  });

  it("leaves the link out for someone who cannot manage billing", () => {
    const html = render(current({ subscriptionStatus: "CANCELLED" }), false);
    expect(html).toContain("cancelled");
    expect(html).not.toContain("/billing");
  });
});

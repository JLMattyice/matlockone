import { describe, expect, it } from "vitest";

import {
  LAUNCH_OFFER,
  launchMonthCents,
  launchOfferApplies,
  launchWeekOpen,
} from "@/lib/billing/launch-offer";
import { PLANS } from "@/lib/checkout/plans";

/**
 * The launch-week offer: who gets half off their first month, and what that
 * month costs. Checkout and both pages ask these, so they are the whole rule.
 */

const before = new Date("2026-10-05T03:59:59Z"); // 11:59:59 pm Eastern, October 4
const opening = new Date("2026-10-05T04:00:00Z"); // midnight Eastern, October 5
const lastEvening = new Date("2026-10-12T03:30:00Z"); // 11:30 pm Eastern, October 11
const closed = new Date("2026-10-12T04:00:00Z"); // midnight Eastern, October 12
const later = new Date("2026-11-20T15:00:00Z");

const newBusiness = (createdAt: Date) => ({
  createdAt,
  subscriptionId: null,
  isDemo: false,
  billingExempt: false,
});

describe("the first month's price", () => {
  it("is half the monthly price", () => {
    expect(launchMonthCents(PLANS.starter)).toBe(1_450);
    expect(launchMonthCents(PLANS.business)).toBe(2_950);
    expect(launchMonthCents(PLANS.pro)).toBe(4_950);
  });

  it("is rounded down, never up, on an odd number of cents", () => {
    expect(launchMonthCents({ ...PLANS.starter, monthlyCents: 2_901 })).toBe(1_450);
  });
});

describe("the week", () => {
  it("runs midnight to midnight Eastern, October 5 through 11", () => {
    expect(LAUNCH_OFFER.discountBp).toBe(5_000);
    expect(launchWeekOpen(before)).toBe(false);
    expect(launchWeekOpen(opening)).toBe(true);
    expect(launchWeekOpen(lastEvening)).toBe(true);
    expect(launchWeekOpen(closed)).toBe(false);
  });
});

describe("who gets it", () => {
  it("is a business that signs up during the week", () => {
    expect(launchOfferApplies(newBusiness(opening), opening)).toBe(true);
    expect(launchOfferApplies(newBusiness(lastEvening), lastEvening)).toBe(true);
  });

  it("still holds for one that signed up in the week and pays after it", () => {
    expect(launchOfferApplies(newBusiness(lastEvening), closed)).toBe(true);
    expect(launchOfferApplies(newBusiness(lastEvening), later)).toBe(true);
  });

  it("includes one that signed up earlier and chooses its first plan during the week", () => {
    expect(launchOfferApplies(newBusiness(new Date("2026-09-28T12:00:00Z")), opening)).toBe(true);
  });

  it("is nobody who both signed up and chose outside the week", () => {
    expect(launchOfferApplies(newBusiness(before), before)).toBe(false);
    expect(launchOfferApplies(newBusiness(before), closed)).toBe(false);
    expect(launchOfferApplies(newBusiness(closed), later)).toBe(false);
  });

  it("is only ever a business's first plan", () => {
    const returning = { ...newBusiness(opening), subscriptionId: "I-EARLIER" };
    expect(launchOfferApplies(returning, opening)).toBe(false);
  });

  it("is never the demo or an exempt business, which are not billed", () => {
    expect(launchOfferApplies({ ...newBusiness(opening), isDemo: true }, opening)).toBe(false);
    expect(launchOfferApplies({ ...newBusiness(opening), billingExempt: true }, opening)).toBe(false);
  });
});

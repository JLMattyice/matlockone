import { describe, expect, it } from "vitest";

import {
  applyRefusal,
  canTakeTrial,
  normalizeTrialCode,
  trialCodeLive,
  trialCodeProblem,
  trialCodeState,
  trialOfferApplies,
  usesLabel,
} from "@/lib/billing/trial-codes";

/**
 * Free-month codes: what counts as a code, when one still works, and which
 * businesses it works for. The billing screen, the checkout and the Accounts
 * page all ask these, so they are the whole rule.
 */

const NOW = new Date("2026-10-15T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const code = (fields: Partial<{ maxUses: number | null; expiresAt: Date | null; disabledAt: Date | null }> = {}) => ({
  maxUses: null,
  expiresAt: null,
  disabledAt: null,
  ...fields,
});

const NEW_BUSINESS = { subscriptionId: null, isDemo: false, billingExempt: false };

describe("what a code looks like", () => {
  it("is kept in capitals with the spaces taken out, however it was typed", () => {
    expect(normalizeTrialCode("friend30")).toBe("FRIEND30");
    expect(normalizeTrialCode("  Friend 30 ")).toBe("FRIEND30");
    expect(normalizeTrialCode(null)).toBe("");
  });

  it("is letters, numbers and dashes, from 3 to 24 of them", () => {
    expect(trialCodeProblem("FRIEND30")).toBeNull();
    expect(trialCodeProblem("FREE-AB12CD")).toBeNull();
    expect(trialCodeProblem("AB")).not.toBeNull();
    expect(trialCodeProblem("A".repeat(25))).not.toBeNull();
    expect(trialCodeProblem("FREE_MONTH")).not.toBeNull();
    expect(trialCodeProblem("FREE!")).not.toBeNull();
  });
});

describe("whether a code still works", () => {
  it("works until it is turned off or reaches its end", () => {
    expect(trialCodeLive(code(), NOW)).toBe(true);
    expect(trialCodeLive(code({ disabledAt: new Date(NOW.getTime() - DAY) }), NOW)).toBe(false);
    expect(trialCodeLive(code({ expiresAt: new Date(NOW.getTime() + 1000) }), NOW)).toBe(true);
    expect(trialCodeLive(code({ expiresAt: NOW }), NOW)).toBe(false);
  });

  it("keeps working for the businesses that used up its limit", () => {
    // The limit is how many may enter it, not a reason to take it back from them.
    expect(trialCodeLive(code({ maxUses: 2 }), NOW)).toBe(true);
    expect(trialCodeState(code({ maxUses: 2 }), 2, NOW)).toBe("used-up");
  });

  it("says where it stands, off before ended before used up", () => {
    expect(trialCodeState(code(), 50, NOW)).toBe("live");
    expect(trialCodeState(code({ maxUses: 3 }), 2, NOW)).toBe("live");
    expect(trialCodeState(code({ maxUses: 3, expiresAt: NOW }), 3, NOW)).toBe("ended");
    expect(trialCodeState(code({ maxUses: 3, expiresAt: NOW, disabledAt: NOW }), 3, NOW)).toBe("off");
  });

  it("counts its uses against its limit for the Accounts page", () => {
    expect(usesLabel(3, null)).toBe("3");
    expect(usesLabel(3, 20)).toBe("3 of 20");
  });
});

describe("who can enter one", () => {
  it("is a business choosing its first plan", () => {
    expect(canTakeTrial(NEW_BUSINESS)).toBe(true);
    expect(canTakeTrial({ ...NEW_BUSINESS, subscriptionId: "I-BEFORE" })).toBe(false);
  });

  it("is never the demo or an exempt business, which are not billed", () => {
    expect(canTakeTrial({ ...NEW_BUSINESS, isDemo: true })).toBe(false);
    expect(canTakeTrial({ ...NEW_BUSINESS, billingExempt: true })).toBe(false);
  });

  it("refuses a code it does not know, one that has stopped, or one that is full", () => {
    expect(applyRefusal(NEW_BUSINESS, null, 0, NOW)).toBe("unknown");
    expect(applyRefusal(NEW_BUSINESS, code({ disabledAt: NOW }), 0, NOW)).toBe("off");
    expect(applyRefusal(NEW_BUSINESS, code({ expiresAt: NOW }), 0, NOW)).toBe("ended");
    expect(applyRefusal(NEW_BUSINESS, code({ maxUses: 5 }), 5, NOW)).toBe("used-up");
    expect(applyRefusal(NEW_BUSINESS, code({ maxUses: 5 }), 4, NOW)).toBeNull();
  });

  it("refuses a business that has had a plan, whatever the code", () => {
    expect(applyRefusal({ ...NEW_BUSINESS, subscriptionId: "I-BEFORE" }, code(), 0, NOW)).toBe("not-first");
  });
});

describe("whether choosing a plan gets the free month", () => {
  it("does on a working code, for a first plan", () => {
    expect(trialOfferApplies(NEW_BUSINESS, code(), NOW)).toBe(true);
  });

  it("does not once the code is turned off or ends, even if it was entered before", () => {
    expect(trialOfferApplies(NEW_BUSINESS, code({ disabledAt: NOW }), NOW)).toBe(false);
    expect(trialOfferApplies(NEW_BUSINESS, code({ expiresAt: NOW }), NOW)).toBe(false);
  });

  it("does not without a code, or after a first plan", () => {
    expect(trialOfferApplies(NEW_BUSINESS, null, NOW)).toBe(false);
    expect(trialOfferApplies({ ...NEW_BUSINESS, subscriptionId: "I-BEFORE" }, code(), NOW)).toBe(false);
  });
});

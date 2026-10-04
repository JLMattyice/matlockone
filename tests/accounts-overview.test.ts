import { describe, expect, it, vi } from "vitest";

/**
 * The operator's Accounts page: who may open it, and how each business is
 * counted. What is pinned: only an address in OPERATOR_EMAILS gets in, and
 * everybody else — a business owner included — gets a plain 404; a business
 * counts as paying exactly when the app would let it in on a live
 * subscription; and the monthly figure takes a twelfth of an annual plan.
 */

const session = vi.hoisted(() => ({ user: { email: "" }, org: {} }));
vi.mock("@/lib/auth", () => ({ requireContext: async () => session }));

import {
  monthlyCentsOf,
  planLabel,
  standingOf,
  summarizeAccounts,
  type AccountFields,
} from "@/lib/accounts-overview";
import { annualCents, PLANS } from "@/lib/checkout/plans";
import { isOperator, operatorEmails, requireOperator } from "@/lib/operator";

const NOW = new Date("2026-10-04T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function account(overrides: Partial<AccountFields> = {}): AccountFields {
  return {
    isDemo: false,
    billingExempt: false,
    licenseKey: null,
    subscriptionStatus: null,
    subscriptionPlan: null,
    subscriptionInterval: null,
    paidThrough: null,
    createdAt: new Date(NOW.getTime() - 100 * DAY),
    ...overrides,
  };
}

const paying = (plan: string, interval: string) =>
  account({
    subscriptionStatus: "ACTIVE",
    subscriptionPlan: plan,
    subscriptionInterval: interval,
    paidThrough: new Date(NOW.getTime() + 10 * DAY),
  });

describe("who may open it", () => {
  it("is whoever OPERATOR_EMAILS names, however the address is typed", () => {
    const env = { OPERATOR_EMAILS: " Lane@Example.com , other@example.com" };
    expect(operatorEmails(env)).toEqual(["lane@example.com", "other@example.com"]);
    expect(isOperator("lane@example.com", env)).toBe(true);
    expect(isOperator("LANE@example.com ", env)).toBe(true);
    expect(isOperator("owner@business.com", env)).toBe(false);
  });

  it("is nobody when it is unset", () => {
    expect(isOperator("lane@example.com", {})).toBe(false);
    expect(isOperator("", { OPERATOR_EMAILS: "" })).toBe(false);
  });

  it("answers anybody else with a plain 404", async () => {
    vi.stubEnv("OPERATOR_EMAILS", "lane@example.com");
    try {
      session.user.email = "owner@business.com";
      await expect(requireOperator()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);

      session.user.email = "lane@example.com";
      await expect(requireOperator()).resolves.toBe(session);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("where a business stands", () => {
  it("is paying on a live subscription, and on one that starts when the paid time ends", () => {
    expect(standingOf(paying("starter", "monthly"), NOW)).toBe("paying");
    expect(standingOf({ ...paying("starter", "monthly"), subscriptionStatus: "APPROVED" }, NOW)).toBe("paying");
  });

  it("tells a cancelled business still open from a payment PayPal is retrying", () => {
    expect(standingOf({ ...paying("pro", "monthly"), subscriptionStatus: "CANCELLED" }, NOW)).toBe("cancelling");
    expect(standingOf({ ...paying("pro", "monthly"), subscriptionStatus: "SUSPENDED" }, NOW)).toBe("past-due");
  });

  it("follows the app's own lock: never paid, or run out", () => {
    expect(standingOf(account(), NOW)).toBe("unpaid");
    expect(standingOf(account({ subscriptionStatus: "APPROVAL_PENDING", subscriptionPlan: "starter" }), NOW)).toBe(
      "unpaid",
    );
    const ranOut = {
      ...paying("starter", "monthly"),
      subscriptionStatus: "EXPIRED",
      paidThrough: new Date(NOW.getTime() - 10 * DAY),
    };
    expect(standingOf(ranOut, NOW)).toBe("lapsed");
  });

  it("is free for an exempt business", () => {
    expect(standingOf(account({ billingExempt: true }), NOW)).toBe("exempt");
  });
});

describe("what it adds up to", () => {
  it("counts a month of a monthly plan and a twelfth of a yearly one", () => {
    expect(monthlyCentsOf(paying("starter", "monthly"), NOW)).toBe(PLANS.starter.monthlyCents);
    expect(monthlyCentsOf(paying("business", "annual"), NOW)).toBe(
      Math.round(annualCents(PLANS.business) / 12),
    );
    expect(monthlyCentsOf({ ...paying("pro", "monthly"), subscriptionStatus: "CANCELLED" }, NOW)).toBe(0);
  });

  it("totals the businesses, the paying ones by plan, and the new ones", () => {
    const summary = summarizeAccounts(
      [
        paying("starter", "monthly"),
        paying("business", "monthly"),
        { ...paying("business", "annual"), createdAt: new Date(NOW.getTime() - 2 * DAY) },
        account({ createdAt: new Date(NOW.getTime() - 20 * DAY) }),
        account({ billingExempt: true }),
      ],
      NOW,
    );

    expect(summary.businesses).toBe(5);
    expect(summary.byStanding).toMatchObject({ paying: 3, unpaid: 1, exempt: 1 });
    expect(summary.byPlan).toEqual({ starter: 1, business: 2, pro: 0 });
    expect(summary.monthlyCents).toBe(
      PLANS.starter.monthlyCents + PLANS.business.monthlyCents + Math.round(annualCents(PLANS.business) / 12),
    );
    expect(summary.newThisWeek).toBe(1);
    expect(summary.newThisMonth).toBe(2);
  });

  it("names the plan and how it is paid", () => {
    expect(planLabel({ subscriptionPlan: "business", subscriptionInterval: "annual" })).toBe("Business · yearly");
    expect(planLabel({ subscriptionPlan: null, subscriptionInterval: null })).toBeNull();
  });
});

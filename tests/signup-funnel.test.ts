import { describe, expect, it } from "vitest";

/**
 * The sign-up funnel on the operator's Accounts page, and what a counted
 * visit may carry to Vercel. What is pinned: each business counts at every
 * step up to the furthest it reached and no further; a column counts only the
 * businesses that signed up in its window; a business that got in without
 * PayPal (a free month, a licence, exempt) still counts as having picked a
 * plan; and a visit's address keeps its path and utm_ tags and loses
 * everything else, including a password-reset token.
 */

import {
  FUNNEL_WINDOWS,
  furthestStep,
  shareOf,
  summarizeFunnel,
  type FunnelFields,
} from "@/lib/signup-funnel";
import { cleanVisitUrl } from "@/lib/visit-url";

const NOW = new Date("2026-10-28T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

function business(overrides: Partial<FunnelFields> = {}): FunnelFields {
  return {
    createdAt: daysAgo(2),
    billingExempt: false,
    licenseKey: null,
    paidThrough: null,
    trialEndsAt: null,
    wentToPayPalAt: null,
    records: 0,
    ...overrides,
  };
}

describe("how far a business got", () => {
  it("stops at the account when it never left for PayPal", () => {
    expect(furthestStep(business())).toBe("signed-up");
  });

  it("picked a plan when it left for PayPal and never came back paid", () => {
    expect(furthestStep(business({ wentToPayPalAt: daysAgo(1) }))).toBe("picked-plan");
  });

  it("got in once paid, on a free month, a licence or exempt", () => {
    expect(furthestStep(business({ wentToPayPalAt: daysAgo(1), paidThrough: daysAgo(-30) }))).toBe("got-in");
    expect(furthestStep(business({ trialEndsAt: daysAgo(-30) }))).toBe("got-in");
    expect(furthestStep(business({ licenseKey: "key" }))).toBe("got-in");
    expect(furthestStep(business({ billingExempt: true }))).toBe("got-in");
  });

  it("still got in after a paid plan ran out", () => {
    expect(furthestStep(business({ paidThrough: daysAgo(60) }))).toBe("got-in");
  });

  it("is using it once anything is in it", () => {
    expect(furthestStep(business({ paidThrough: daysAgo(-30), records: 3 }))).toBe("using");
  });
});

describe("the funnel's columns", () => {
  const orgs = [
    business({ createdAt: daysAgo(1) }),
    business({ createdAt: daysAgo(3), wentToPayPalAt: daysAgo(3) }),
    business({ createdAt: daysAgo(10), paidThrough: daysAgo(-20), records: 5 }),
    business({ createdAt: daysAgo(200), trialEndsAt: daysAgo(170) }),
  ];
  const demo = [daysAgo(0.5), daysAgo(20), daysAgo(400)];

  const [week, month, all] = summarizeFunnel(orgs, demo, NOW);

  it("counts each business at every step it reached", () => {
    expect(all.reached).toEqual({ "signed-up": 4, "picked-plan": 3, "got-in": 2, using: 1 });
  });

  it("counts only the businesses that signed up in the window", () => {
    expect(week.reached).toEqual({ "signed-up": 2, "picked-plan": 1, "got-in": 0, using: 0 });
    expect(month.reached).toEqual({ "signed-up": 3, "picked-plan": 2, "got-in": 1, using: 1 });
  });

  it("counts demo sign-ins in each window", () => {
    expect([week.demoSignIns, month.demoSignIns, all.demoSignIns]).toEqual([1, 2, 3]);
  });

  it("has a column for each window, in order", () => {
    expect([week, month, all].map((column) => column.window)).toEqual(FUNNEL_WINDOWS);
  });

  it("gives a share of those who made an account, and none of nobody", () => {
    expect(shareOf(2, 3)).toBe("67%");
    expect(shareOf(0, 0)).toBeNull();
  });
});

describe("what a counted visit carries", () => {
  it("keeps the path and the campaign tags", () => {
    expect(cleanVisitUrl("https://www.matlockone.com/signup?utm_source=facebook&utm_campaign=fall")).toBe(
      "https://www.matlockone.com/signup?utm_source=facebook&utm_campaign=fall",
    );
  });

  it("drops a free-month code, a next path and anything else in the query", () => {
    expect(cleanVisitUrl("https://www.matlockone.com/billing?welcome=1&code=FREEMONTH")).toBe(
      "https://www.matlockone.com/billing",
    );
    expect(cleanVisitUrl("https://www.matlockone.com/login?next=%2Finvoices%2Fabc")).toBe(
      "https://www.matlockone.com/login",
    );
  });

  it("never carries a password-reset token", () => {
    expect(cleanVisitUrl("https://www.matlockone.com/reset-password/s3cr3t-token?x=1")).toBe(
      "https://www.matlockone.com/reset-password/[token]",
    );
  });

  it("drops the hash, and copes with an address it cannot read", () => {
    expect(cleanVisitUrl("https://www.matlockone.com/#pricing")).toBe("https://www.matlockone.com/");
    expect(cleanVisitUrl("/signup?code=X#top")).toBe("/signup");
  });
});

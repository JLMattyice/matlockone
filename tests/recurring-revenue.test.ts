import { describe, expect, it } from "vitest";

import {
  isLiveSeries,
  monthlyEquivalentCents,
  recurringRevenue,
  type RecurringSeries,
} from "@/lib/recurring-revenue";

/**
 * Recurring revenue adds up money billed on different rhythms, so what can go
 * wrong is the conversion: a weekly invoice counted as four a month, a yearly
 * one counted in full, or a finished series still counted as coming back.
 */

function series(overrides: Partial<RecurringSeries> = {}): RecurringSeries {
  return {
    frequency: "MONTHLY",
    interval: 1,
    isActive: true,
    nextIssueDate: new Date("2026-10-01T00:00:00Z"),
    endDate: null,
    amountCents: 250_000,
    ...overrides,
  };
}

describe("monthlyEquivalentCents", () => {
  it("leaves a monthly invoice as it is", () => {
    expect(monthlyEquivalentCents(250_000, "MONTHLY", 1)).toBe(250_000);
  });

  it("spreads a weekly invoice over 52 weeks, not four", () => {
    // $100 a week is $433.33 a month. Four weeks would say $400 and lose a
    // month's worth of invoices every year.
    expect(monthlyEquivalentCents(10_000, "WEEKLY", 1)).toBe(43_333);
  });

  it("divides a yearly invoice across the year", () => {
    expect(monthlyEquivalentCents(120_000, "YEARLY", 1)).toBe(10_000);
  });

  it("allows for the interval", () => {
    expect(monthlyEquivalentCents(10_000, "WEEKLY", 2)).toBe(21_667);
    expect(monthlyEquivalentCents(300_000, "MONTHLY", 3)).toBe(100_000);
    expect(monthlyEquivalentCents(240_000, "YEARLY", 2)).toBe(10_000);
  });

  it("always returns whole cents", () => {
    for (const frequency of ["WEEKLY", "MONTHLY", "YEARLY"]) {
      for (const interval of [1, 2, 3, 7]) {
        expect(Number.isInteger(monthlyEquivalentCents(9_999, frequency, interval))).toBe(true);
      }
    }
  });

  it("treats a nonsense interval as every period rather than dividing by zero", () => {
    expect(monthlyEquivalentCents(50_000, "MONTHLY", 0)).toBe(50_000);
  });
});

describe("isLiveSeries", () => {
  it("counts a running series", () => {
    expect(isLiveSeries(series())).toBe(true);
  });

  it("drops a stopped one", () => {
    expect(isLiveSeries(series({ isActive: false }))).toBe(false);
  });

  it("drops one whose end date has passed its next draft", () => {
    // Still isActive once the last draft is made; finished all the same.
    expect(
      isLiveSeries(
        series({
          nextIssueDate: new Date("2026-11-01T00:00:00Z"),
          endDate: new Date("2026-10-15T00:00:00Z"),
        }),
      ),
    ).toBe(false);
  });

  it("keeps one whose last draft is still to come", () => {
    expect(
      isLiveSeries(series({ endDate: new Date("2026-12-31T00:00:00Z") })),
    ).toBe(true);
  });
});

describe("recurringRevenue", () => {
  it("adds every live series in monthly terms, largest first", () => {
    const result = recurringRevenue([
      series({ amountCents: 50_000 }),
      series({ frequency: "YEARLY", amountCents: 1_200_000 }),
      series({ frequency: "WEEKLY", amountCents: 10_000 }),
      series({ isActive: false, amountCents: 999_999 }),
    ]);

    expect(result.count).toBe(3);
    expect(result.monthlyCents).toBe(50_000 + 100_000 + 43_333);
    expect(result.yearlyCents).toBe(result.monthlyCents * 12);
    expect(result.series.map((row) => row.monthlyCents)).toEqual([
      100_000, 50_000, 43_333,
    ]);
  });

  it("leaves out a series with nothing to bill", () => {
    const result = recurringRevenue([
      series({ amountCents: null }),
      series({ amountCents: 0 }),
    ]);

    expect(result).toMatchObject({ count: 0, monthlyCents: 0, yearlyCents: 0 });
  });

  it("keeps what the caller attached to each series", () => {
    const result = recurringRevenue([{ ...series(), client: "Johnson LLC" }]);
    expect(result.series[0].client).toBe("Johnson LLC");
  });
});

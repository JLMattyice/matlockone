import { describe, expect, it } from "vitest";

import {
  centsToInput,
  clamp,
  computeTotals,
  currencySymbol,
  formatMoney,
  formatRate,
  lineTotalCents,
  parseMoneyToCents,
  parseRateToBp,
} from "@/lib/money";

describe("parseMoneyToCents", () => {
  it("reads the shapes people actually type", () => {
    expect(parseMoneyToCents("1250")).toBe(125000);
    expect(parseMoneyToCents("1250.5")).toBe(125050);
    expect(parseMoneyToCents("1,250.50")).toBe(125050);
    expect(parseMoneyToCents("$1,250.50")).toBe(125050);
    expect(parseMoneyToCents(" 1250.50 ")).toBe(125050);
  });

  it("accepts a number as well as a string", () => {
    expect(parseMoneyToCents(89)).toBe(8900);
    expect(parseMoneyToCents(89.99)).toBe(8999);
  });

  it("returns null rather than 0 for anything unparseable", () => {
    // 0 would silently become a free line item; null lets the caller decide.
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents(null)).toBeNull();
    expect(parseMoneyToCents(undefined)).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("$")).toBeNull();
    expect(parseMoneyToCents(".")).toBeNull();
    expect(parseMoneyToCents("-")).toBeNull();
    expect(parseMoneyToCents(Number.NaN)).toBeNull();
    expect(parseMoneyToCents(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("handles negatives, for credits", () => {
    expect(parseMoneyToCents("-50.00")).toBe(-5000);
  });

  it("rounds to the nearest cent instead of truncating", () => {
    expect(parseMoneyToCents("0.005")).toBe(1);
    expect(parseMoneyToCents("0.004")).toBe(0);
    // The classic float case: 1.005 * 100 is 100.49999... in binary.
    expect(parseMoneyToCents("10.555")).toBe(1056);
  });

  it("round-trips through centsToInput", () => {
    for (const cents of [0, 1, 999, 125050, -5000]) {
      expect(parseMoneyToCents(centsToInput(cents))).toBe(cents);
    }
  });
});

describe("rates", () => {
  it("converts a percent to basis points", () => {
    expect(parseRateToBp("8.25")).toBe(825);
    expect(parseRateToBp("7")).toBe(700);
    expect(parseRateToBp("0")).toBe(0);
    expect(parseRateToBp("")).toBeNull();
  });

  it("formats basis points back to a percent", () => {
    expect(formatRate(825)).toBe("8.25%");
    expect(formatRate(700)).toBe("7%");
    expect(formatRate(0)).toBe("0%");
  });
});

describe("lineTotalCents", () => {
  it("rounds the product to whole cents", () => {
    expect(lineTotalCents(1, 480000)).toBe(480000);
    expect(lineTotalCents(8, 9500)).toBe(76000);
    // 2.5 x 333 = 832.5, which must not become 832 by truncation.
    expect(lineTotalCents(2.5, 333)).toBe(833);
    expect(lineTotalCents(0.1, 1000)).toBe(100);
  });

  it("handles fractional quantities like logged hours", () => {
    expect(lineTotalCents(5.18, 3800)).toBe(19684);
  });
});

describe("computeTotals", () => {
  const taxable = (quantity: number, unitPriceCents: number) => ({
    quantity,
    unitPriceCents,
    taxable: true,
  });
  const exempt = (quantity: number, unitPriceCents: number) => ({
    quantity,
    unitPriceCents,
    taxable: false,
  });

  it("sums lines with no discount or tax", () => {
    const totals = computeTotals({
      lineItems: [taxable(1, 480000), taxable(8, 9500)],
      discountType: "NONE",
      discountValue: 0,
      taxRateBp: 0,
    });

    expect(totals.lineTotalsCents).toEqual([480000, 76000]);
    expect(totals.subtotalCents).toBe(556000);
    expect(totals.discountCents).toBe(0);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(556000);
  });

  it("applies tax only to taxable lines", () => {
    const totals = computeTotals({
      lineItems: [taxable(1, 100000), exempt(1, 100000)],
      discountType: "NONE",
      discountValue: 0,
      taxRateBp: 1000, // 10%
    });

    expect(totals.subtotalCents).toBe(200000);
    // 10% of the taxable 1000.00 only, not of the 2000.00 subtotal.
    expect(totals.taxCents).toBe(10000);
    expect(totals.totalCents).toBe(210000);
  });

  it("takes a percent discount off the subtotal", () => {
    const totals = computeTotals({
      lineItems: [taxable(1, 100000)],
      discountType: "PERCENT",
      discountValue: 1000, // 10% in basis points
      taxRateBp: 0,
    });

    expect(totals.discountCents).toBe(10000);
    expect(totals.totalCents).toBe(90000);
  });

  it("takes a fixed discount in cents", () => {
    const totals = computeTotals({
      lineItems: [taxable(1, 100000)],
      discountType: "FIXED",
      discountValue: 25000,
      taxRateBp: 0,
    });

    expect(totals.discountCents).toBe(25000);
    expect(totals.totalCents).toBe(75000);
  });

  it("never discounts below zero", () => {
    const totals = computeTotals({
      lineItems: [taxable(1, 10000)],
      discountType: "FIXED",
      discountValue: 50000, // more than the subtotal
      taxRateBp: 1000,
    });

    expect(totals.discountCents).toBe(10000);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(0);
  });

  /**
   * The case the apportionment exists for.
   *
   * Subtotal 1000.00, of which 600.00 is taxable. A 10% discount is 100.00.
   * Only 60% of the document is taxable, so only 60.00 of that discount can
   * reduce the taxable base: 600 - 60 = 540, taxed at 10% = 54.00.
   *
   * Taxing the undiscounted 600.00 would give 60.00 and overcharge the client
   * by 6.00 on a single invoice.
   */
  it("apportions a discount across the taxable and exempt slices", () => {
    const totals = computeTotals({
      lineItems: [taxable(1, 60000), exempt(1, 40000)],
      discountType: "PERCENT",
      discountValue: 1000,
      taxRateBp: 1000,
    });

    expect(totals.subtotalCents).toBe(100000);
    expect(totals.discountCents).toBe(10000);
    expect(totals.taxCents).toBe(5400);
    expect(totals.totalCents).toBe(95400);
  });

  it("does not divide by zero on an empty or free document", () => {
    const empty = computeTotals({
      lineItems: [],
      discountType: "PERCENT",
      discountValue: 1000,
      taxRateBp: 825,
    });

    expect(empty.subtotalCents).toBe(0);
    expect(empty.discountCents).toBe(0);
    expect(empty.taxCents).toBe(0);
    expect(empty.totalCents).toBe(0);
    expect(Number.isNaN(empty.totalCents)).toBe(false);

    const free = computeTotals({
      lineItems: [taxable(1, 0)],
      discountType: "PERCENT",
      discountValue: 5000,
      taxRateBp: 825,
    });
    expect(free.totalCents).toBe(0);
  });

  it("carries a negative line through as a credit", () => {
    const totals = computeTotals({
      lineItems: [taxable(1, 50000), taxable(1, -20000)],
      discountType: "NONE",
      discountValue: 0,
      taxRateBp: 1000,
    });

    expect(totals.subtotalCents).toBe(30000);
    expect(totals.taxCents).toBe(3000);
    expect(totals.totalCents).toBe(33000);
  });

  it("keeps line totals aligned with the input order", () => {
    const totals = computeTotals({
      lineItems: [taxable(2, 1000), exempt(3, 500), taxable(1, 250)],
      discountType: "NONE",
      discountValue: 0,
      taxRateBp: 0,
    });

    expect(totals.lineTotalsCents).toEqual([2000, 1500, 250]);
    expect(totals.subtotalCents).toBe(3750);
  });

  it("reproduces a real invoice end to end", () => {
    // The estimate built during phase 4: a $4,800 unit plus 8 hours at $95,
    // taxed at 7.25%.
    const totals = computeTotals({
      lineItems: [taxable(1, 480000), taxable(8, 9500)],
      discountType: "NONE",
      discountValue: 0,
      taxRateBp: 725,
    });

    expect(totals.subtotalCents).toBe(556000);
    expect(totals.taxCents).toBe(40310);
    expect(totals.totalCents).toBe(596310);
    expect(formatMoney(totals.totalCents)).toBe("$5,963.10");
  });
});

describe("formatting", () => {
  it("formats cents as currency", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(596310)).toBe("$5,963.10");
    expect(formatMoney(-5000)).toBe("-$50.00");
  });

  it("extracts the currency symbol for input prefixes", () => {
    expect(currencySymbol("USD", "en-US")).toBe("$");
    expect(currencySymbol("GBP", "en-GB")).toBe("£");
  });
});

describe("clamp", () => {
  it("bounds a value both ways", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });
});

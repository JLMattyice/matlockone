/**
 * Money is integer cents everywhere. Rates are basis points (825 = 8.25%).
 * Nothing in this file uses floating point for currency arithmetic.
 */

import type { DiscountType } from "./constants";

export const BP_DIVISOR = 10_000;

export function formatMoney(
  cents: number,
  currency = "USD",
  locale = "en-US",
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(cents / 100);
}

/** Compact form for dashboard tiles: $12.4k, $1.2M. */
export function formatMoneyCompact(
  cents: number,
  currency = "USD",
  locale = "en-US",
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

/**
 * Parse user input ("1,250.50", "$1250.5", "1250") into cents.
 * Returns null for anything that is not a finite number.
 */
export function parseMoneyToCents(input: string | number | null | undefined) {
  if (input == null || input === "") return null;
  if (typeof input === "number") {
    return Number.isFinite(input) ? Math.round(input * 100) : null;
  }
  const cleaned = input.replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** Cents -> a plain "1250.50" string suitable for a number input value. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

/** The currency's symbol on its own, for prefixing a bare number input. */
export function currencySymbol(currency = "USD", locale = "en-US"): string {
  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).formatToParts(0);

  return parts.find((part) => part.type === "currency")?.value ?? "$";
}

export function formatRate(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 2)}%`;
}

export function parseRateToBp(input: string | number | null | undefined) {
  if (input == null || input === "") return null;
  const value = typeof input === "number" ? input : Number(String(input).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

// -------------------------------------------------------- document totals ---

export type TotalsLineInput = {
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
};

export type TotalsInput = {
  lineItems: TotalsLineInput[];
  discountType: DiscountType;
  /** Basis points when PERCENT, cents when FIXED, ignored when NONE. */
  discountValue: number;
  taxRateBp: number;
  /**
   * Already billed, on a final invoice: taken off after tax, so the tax is
   * the whole job's and only the amount still due changes.
   */
  creditCents?: number;
};

export type Totals = {
  lineTotalsCents: number[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  /** The credit as applied — never more than the document comes to. */
  creditCents: number;
  totalCents: number;
};

export function lineTotalCents(quantity: number, unitPriceCents: number) {
  return Math.round(quantity * unitPriceCents);
}

/**
 * Single source of truth for estimate and invoice arithmetic.
 *
 * A discount reduces the taxable base proportionally, so a 10% discount on a
 * document whose lines are partly non-taxable does not over-credit the tax.
 */
export function computeTotals(input: TotalsInput): Totals {
  const lineTotalsCents = input.lineItems.map((item) =>
    lineTotalCents(item.quantity, item.unitPriceCents),
  );

  const subtotalCents = lineTotalsCents.reduce((sum, n) => sum + n, 0);

  const taxableSubtotalCents = input.lineItems.reduce(
    (sum, item, i) => (item.taxable ? sum + lineTotalsCents[i] : sum),
    0,
  );

  let discountCents = 0;
  if (input.discountType === "PERCENT") {
    discountCents = Math.round((subtotalCents * input.discountValue) / BP_DIVISOR);
  } else if (input.discountType === "FIXED") {
    discountCents = input.discountValue;
  }
  discountCents = clamp(discountCents, 0, Math.max(subtotalCents, 0));

  // Apportion the discount onto the taxable slice by its share of the subtotal.
  const taxableDiscountCents =
    subtotalCents > 0
      ? Math.round((discountCents * taxableSubtotalCents) / subtotalCents)
      : 0;

  const taxableBaseCents = Math.max(
    taxableSubtotalCents - taxableDiscountCents,
    0,
  );
  const taxCents = Math.round((taxableBaseCents * input.taxRateBp) / BP_DIVISOR);

  const grossCents = subtotalCents - discountCents + taxCents;
  const creditCents = clamp(input.creditCents ?? 0, 0, Math.max(grossCents, 0));
  const totalCents = grossCents - creditCents;

  return { lineTotalsCents, subtotalCents, discountCents, taxCents, creditCents, totalCents };
}

/**
 * What a deposit comes to: a percent of the total (basis points) or a fixed
 * amount, never more than the total and never negative.
 */
export function depositCentsFor(totalCents: number, type: string, value: number): number {
  if (type === "PERCENT") return clamp(Math.round((totalCents * value) / BP_DIVISOR), 0, Math.max(totalCents, 0));
  if (type === "FIXED") return clamp(value, 0, Math.max(totalCents, 0));
  return 0;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

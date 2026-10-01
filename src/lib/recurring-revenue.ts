import { endOfDay } from "date-fns";

/**
 * What the repeating invoices are worth, as a monthly figure.
 *
 * A retainer billed monthly, a maintenance plan billed yearly and a cleaning
 * billed every two weeks are the same kind of money — it comes back without
 * anybody having to win it again — but they cannot be added up as billed. So
 * each is turned into what it brings in over an average month, and those are
 * added.
 *
 * The amount of a series is its latest invoice, the same one the next draft
 * is copied from, so a price raised on this month's draft moves the figure
 * straight away. Pure, so the arithmetic is tested rather than eyeballed.
 */

/** 52 weeks across 12 months: a weekly invoice is billed 4⅓ times a month. */
const WEEKS_PER_YEAR = 52;

export type RecurringSeries = {
  frequency: string;
  interval: number;
  isActive: boolean;
  nextIssueDate: Date;
  endDate: Date | null;
  /** Total of the latest invoice in the series, or null if it has none. */
  amountCents: number | null;
};

/**
 * One period's amount spread over an average month, in whole cents.
 *
 * Rounded once, at the end, from an exact fraction: a $100 weekly invoice is
 * 100 × 52 / 12 = $433.33, not 4.33 weeks × $100 = $433.00.
 */
export function monthlyEquivalentCents(
  amountCents: number,
  frequency: string,
  interval: number,
): number {
  const every = Math.max(1, Math.trunc(interval) || 1);

  switch (frequency) {
    case "WEEKLY":
      return Math.round((amountCents * WEEKS_PER_YEAR) / (12 * every));
    case "YEARLY":
      return Math.round(amountCents / (12 * every));
    case "MONTHLY":
    default:
      return Math.round(amountCents / every);
  }
}

/**
 * Whether a series will bill again.
 *
 * A stopped series is out, and so is one whose end date has passed: those are
 * left `isActive` once the last draft is made, the same way the Repeat card
 * tells "Finished" apart from "Stopped".
 */
export function isLiveSeries(series: RecurringSeries): boolean {
  if (!series.isActive) return false;
  if (!series.endDate) return true;
  return series.nextIssueDate <= endOfDay(series.endDate);
}

export function recurringRevenue<T extends RecurringSeries>(series: T[]) {
  const live = series
    .filter(isLiveSeries)
    .filter((row) => (row.amountCents ?? 0) > 0)
    .map((row) => ({
      ...row,
      monthlyCents: monthlyEquivalentCents(
        row.amountCents ?? 0,
        row.frequency,
        row.interval,
      ),
    }))
    .sort((a, b) => b.monthlyCents - a.monthlyCents);

  const monthlyCents = live.reduce((sum, row) => sum + row.monthlyCents, 0);

  return {
    series: live,
    count: live.length,
    monthlyCents,
    yearlyCents: monthlyCents * 12,
  };
}

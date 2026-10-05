import type { Plan } from "@/lib/checkout/plans";

/**
 * The launch-week offer: half off the first month of a monthly plan, for the
 * businesses that sign up in Matlock One's first week on sale.
 *
 * PayPal does the discounting, through a "launch offer" billing plan for each
 * tier — one discounted month, then the full price until cancelled — made by
 * `npm run paypal:setup`. Nothing here changes what anybody is charged; it
 * only decides which of the two plans a business is sent to.
 *
 * Yearly plans are left out on purpose: they already carry their own discount.
 */

export const LAUNCH_OFFER = {
  // Midnight to midnight Eastern, October 5 through October 11 (EDT, UTC−4).
  startsAt: new Date("2026-10-05T04:00:00Z"),
  endsAt: new Date("2026-10-12T04:00:00Z"),
  /** Off the first month, in basis points — 5000 = 50%. */
  discountBp: 5000,
  /** As it is written to a person. */
  dates: "October 5–11",
} as const;

/**
 * What the first month costs on the offer. Rounded down to the cent, like the
 * yearly price, so the discount is never a cent smaller than the one promised.
 */
export function launchMonthCents(plan: Plan): number {
  return plan.monthlyCents - Math.ceil((plan.monthlyCents * LAUNCH_OFFER.discountBp) / 10_000);
}

const duringLaunchWeek = (date: Date) =>
  date.getTime() >= LAUNCH_OFFER.startsAt.getTime() && date.getTime() < LAUNCH_OFFER.endsAt.getTime();

/** Whether the week is on now — what the homepage advertises by. */
export function launchWeekOpen(now: Date = new Date()): boolean {
  return duringLaunchWeek(now);
}

/**
 * Whether a business choosing a plan gets the offer.
 *
 * Its first plan only: a business that has ever held a subscription has had
 * its first month. Signing up during the week is enough, so somebody who
 * makes the account on the last evening and pays the next morning still has
 * it; so is choosing that first plan during the week. Never the demo or an
 * exempt business, which are not billed at all.
 */
export function launchOfferApplies(
  org: {
    createdAt: Date;
    subscriptionId: string | null;
    isDemo: boolean;
    billingExempt: boolean;
  },
  now: Date = new Date(),
): boolean {
  if (org.isDemo || org.billingExempt || org.subscriptionId !== null) return false;
  return duringLaunchWeek(org.createdAt) || duringLaunchWeek(now);
}

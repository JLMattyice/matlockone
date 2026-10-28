/**
 * How far the businesses that sign up get, for the operator's Accounts page:
 * made an account, picked a plan, paid (or started a free month), started
 * using it.
 *
 * Everything after the sign-up form is already on the business's own row
 * except one thing — leaving for PayPal and not coming back leaves no trace.
 * That, and signing in to the demo, are written to the audit log under
 * FUNNEL_PREFIX (see funnel-events.ts), which the workspace's own activity
 * feed never shows: these are the operator's counts, not the business's news.
 *
 * Visits to the website itself are counted by Vercel Web Analytics, not here.
 *
 * Pure, so every case is tested without a database.
 */

export const FUNNEL_PREFIX = "funnel.";

/** A business left the billing screen for PayPal to approve a plan. */
export const CHECKOUT_ACTION = `${FUNNEL_PREFIX}checkout`;

/** Somebody signed in to the shared demo. */
export const DEMO_ACTION = `${FUNNEL_PREFIX}demo`;

export type FunnelStep = "signed-up" | "picked-plan" | "got-in" | "using";

export const FUNNEL_STEPS: FunnelStep[] = ["signed-up", "picked-plan", "got-in", "using"];

export const FUNNEL_META: Record<FunnelStep, { label: string; hint: string }> = {
  "signed-up": { label: "Made an account", hint: "Filled in the sign-up form." },
  "picked-plan": {
    label: "Picked a plan",
    hint: "Went to PayPal to pay, or started a free month with a code.",
  },
  "got-in": { label: "Paid or free month", hint: "Finished at PayPal, or a free month started." },
  using: { label: "Started using it", hint: "Added a customer, job, estimate or invoice." },
};

export type FunnelFields = {
  createdAt: Date;
  billingExempt: boolean;
  licenseKey: string | null;
  paidThrough: Date | null;
  trialEndsAt: Date | null;
  /** The first time it left for PayPal, if it ever did. */
  wentToPayPalAt: Date | null;
  /** Customers, jobs, estimates and invoices, added together. */
  records: number;
};

/**
 * Whether the business ever got in. The same line entitlement() draws between
 * "never paid" and everything else, plus a free month, which opens the
 * business before any payment.
 */
function gotIn(org: FunnelFields): boolean {
  return Boolean(org.billingExempt || org.licenseKey || org.paidThrough || org.trialEndsAt);
}

/** The furthest step this business has reached. */
export function furthestStep(org: FunnelFields): FunnelStep {
  if (org.records > 0) return "using";
  if (gotIn(org)) return "got-in";
  if (org.wentToPayPalAt) return "picked-plan";
  return "signed-up";
}

export type FunnelWindow = { key: string; label: string; days: number | null };

export const FUNNEL_WINDOWS: FunnelWindow[] = [
  { key: "week", label: "Last 7 days", days: 7 },
  { key: "month", label: "Last 30 days", days: 30 },
  { key: "all", label: "All time", days: null },
];

export type FunnelColumn = {
  window: FunnelWindow;
  /** How many of the businesses that signed up in the window reached each step. */
  reached: Record<FunnelStep, number>;
  /** Demo sign-ins in the window. */
  demoSignIns: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function inWindow(date: Date, window: FunnelWindow, now: Date): boolean {
  return window.days === null || now.getTime() - date.getTime() < window.days * DAY_MS;
}

/**
 * One column per window, each counting the businesses that signed up in it —
 * so a column reads as "of the people who joined then, this many got this
 * far", and a business that paid today for an account made last month counts
 * under last month's sign-ups, not this week's.
 */
export function summarizeFunnel(
  orgs: FunnelFields[],
  demoSignIns: Date[],
  now: Date = new Date(),
  windows: FunnelWindow[] = FUNNEL_WINDOWS,
): FunnelColumn[] {
  return windows.map((window) => {
    const reached = Object.fromEntries(FUNNEL_STEPS.map((step) => [step, 0])) as Record<FunnelStep, number>;

    for (const org of orgs) {
      if (!inWindow(org.createdAt, window, now)) continue;
      const furthest = FUNNEL_STEPS.indexOf(furthestStep(org));
      for (let i = 0; i <= furthest; i++) reached[FUNNEL_STEPS[i]]++;
    }

    return {
      window,
      reached,
      demoSignIns: demoSignIns.filter((at) => inWindow(at, window, now)).length,
    };
  });
}

/** "64%" of those who made an account, or null when nobody did. */
export function shareOf(count: number, of: number): string | null {
  if (of === 0) return null;
  return `${Math.round((count / of) * 100)}%`;
}

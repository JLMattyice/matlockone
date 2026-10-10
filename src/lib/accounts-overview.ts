import { entitlement, type BillingFields } from "./billing/entitlement";
import { annualCents, isPlan, PLANS, PLAN_ORDER } from "./checkout/plans";
import type { Tone } from "./constants";
import type { LicensePlan } from "./license/token";

/**
 * Where each business stands with Matlock One, for the operator's Accounts
 * page: who pays, who signed up and never did, who cancelled.
 *
 * Read through the same entitlement() that decides whether a business is open,
 * so this page can never call a business "paying" that the app has locked, or
 * the other way round. Pure, so every case is tested without a database.
 */

export type Standing =
  | "paying"
  | "trial"
  | "past-due"
  | "cancelling"
  | "unpaid"
  | "lapsed"
  | "exempt"
  | "licence";

export const STANDING_META: Record<Standing, { label: string; tone: Tone; hint: string }> = {
  paying: { label: "Paying", tone: "success", hint: "Subscription active and paid up." },
  trial: {
    label: "Free month",
    tone: "info",
    hint: "On the free month from a code. PayPal takes the first payment when it ends, unless they cancel.",
  },
  "past-due": {
    label: "Payment problem",
    tone: "warning",
    hint: "PayPal could not take the last payment and has paused the subscription. Still open for a few days while it retries.",
  },
  cancelling: {
    label: "Cancelled",
    tone: "warning",
    hint: "Cancelled, and open until the time already paid for runs out.",
  },
  unpaid: { label: "Never paid", tone: "neutral", hint: "Made an account and has not chosen a plan." },
  lapsed: { label: "Lapsed", tone: "danger", hint: "Paid once; the subscription has run out and the business is locked." },
  exempt: { label: "Free", tone: "accent", hint: "Exempt from billing, set by hand." },
  licence: { label: "Licence key", tone: "info", hint: "Runs on a licence key rather than a subscription." },
};

/** In the order the page lists them. */
export const STANDINGS: Standing[] = [
  "paying",
  "trial",
  "past-due",
  "cancelling",
  "unpaid",
  "lapsed",
  "exempt",
  "licence",
];

export function isStanding(value: unknown): value is Standing {
  return typeof value === "string" && (STANDINGS as string[]).includes(value);
}

/** When a free month from a code ends, if the business had one. */
type TrialFields = { trialEndsAt?: Date | null };

export type AccountFields = BillingFields &
  TrialFields & {
    createdAt: Date;
    subscriptionInterval: string | null;
  };

export function standingOf(org: BillingFields & TrialFields, now: Date = new Date()): Standing {
  const access = entitlement(org, now);
  if (!access.ok) return access.reason === "never-paid" ? "unpaid" : "lapsed";
  if (access.via === "licence") return "licence";
  if (access.via !== "subscription") return "exempt";

  // Open on a subscription: whether it will charge again is what PayPal says.
  // APPROVED is one that starts when the time already paid for runs out. An
  // active one still in its free month has not paid anything yet, so it is
  // not counted as paying until the month is up.
  if (
    org.subscriptionStatus === "ACTIVE" &&
    org.trialEndsAt &&
    org.trialEndsAt.getTime() > now.getTime()
  ) {
    return "trial";
  }
  if (org.subscriptionStatus === "ACTIVE" || org.subscriptionStatus === "APPROVED") return "paying";
  if (org.subscriptionStatus === "SUSPENDED") return "past-due";
  return "cancelling";
}

/**
 * What a paying business brings in a month, in cents: its plan's monthly
 * price, or a twelfth of the annual one. Zero for anybody not paying.
 */
export function monthlyCentsOf(org: AccountFields, now: Date = new Date()): number {
  if (standingOf(org, now) !== "paying" || !isPlan(org.subscriptionPlan)) return 0;
  const plan = PLANS[org.subscriptionPlan];
  return org.subscriptionInterval === "annual"
    ? Math.round(annualCents(plan) / 12)
    : plan.monthlyCents;
}

/** "Business · yearly", or null when there is no plan to name. */
export function planLabel(org: { subscriptionPlan: string | null; subscriptionInterval: string | null }) {
  if (!isPlan(org.subscriptionPlan)) return null;
  const name = PLANS[org.subscriptionPlan].name;
  if (org.subscriptionInterval === "annual") return `${name} · yearly`;
  if (org.subscriptionInterval === "monthly") return `${name} · monthly`;
  return name;
}

export type AccountsSummary = {
  businesses: number;
  byStanding: Record<Standing, number>;
  /** Paying businesses on each plan. */
  byPlan: Record<LicensePlan, number>;
  monthlyCents: number;
  newThisWeek: number;
  newThisMonth: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function summarizeAccounts(orgs: AccountFields[], now: Date = new Date()): AccountsSummary {
  const byStanding = Object.fromEntries(STANDINGS.map((s) => [s, 0])) as Record<Standing, number>;
  const byPlan = Object.fromEntries(PLAN_ORDER.map((p) => [p, 0])) as Record<LicensePlan, number>;
  let monthlyCents = 0;
  let newThisWeek = 0;
  let newThisMonth = 0;

  for (const org of orgs) {
    const standing = standingOf(org, now);
    byStanding[standing]++;
    if (standing === "paying" && isPlan(org.subscriptionPlan)) byPlan[org.subscriptionPlan]++;
    monthlyCents += monthlyCentsOf(org, now);

    const age = now.getTime() - org.createdAt.getTime();
    if (age < 7 * DAY_MS) newThisWeek++;
    if (age < 30 * DAY_MS) newThisMonth++;
  }

  return { businesses: orgs.length, byStanding, byPlan, monthlyCents, newThisWeek, newThisMonth };
}

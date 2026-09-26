import { PLANS, isPlan } from "@/lib/checkout/plans";
import { licenseState } from "@/lib/license/status";
import type { LicensePlan } from "@/lib/license/token";

/**
 * Whether a business may use Matlock One right now.
 *
 * There is no free tier. A business is open while one of these is true, and
 * closed — sign-in shows only the billing screen — when none is:
 *
 *  - it is the demo, which nobody pays for and nobody can change;
 *  - it is exempt, which the operator sets by hand for their own business;
 *  - it holds a valid licence key, which is how a desktop install pays, and
 *    which also works as a comp on the hosted app;
 *  - its PayPal subscription has paid through today, or did within the last
 *    few days.
 *
 * The grace is for PayPal, not for the customer. A renewal that fails is
 * retried over several days before the subscription is suspended, and a
 * business whose card had a bad morning should not find itself locked out of
 * its own records while PayPal is still trying. A cancelled subscription stays
 * open to the end of what was paid for: cancelling stops the next charge, not
 * the month already bought.
 *
 * Pure, so every case is tested without a database or a clock.
 */

export const GRACE_DAYS = 3;

/** Where a business that is not open is sent, and where every plan is chosen. */
export const BILLING_PATH = "/billing";

const DAY_MS = 24 * 60 * 60 * 1000;

export type BillingFields = {
  isDemo: boolean;
  billingExempt: boolean;
  licenseKey: string | null;
  subscriptionStatus: string | null;
  subscriptionPlan: string | null;
  paidThrough: Date | null;
};

export type Entitlement =
  | {
      ok: true;
      via: "demo" | "exempt" | "licence" | "subscription";
      plan: LicensePlan | null;
      /** Active people allowed, or null for unlimited. */
      seats: number | null;
    }
  | {
      ok: false;
      /** Never paid, or paid once and it has run out. The screen says which. */
      reason: "never-paid" | "lapsed";
    };

export function entitlement(org: BillingFields, now: Date = new Date()): Entitlement {
  if (org.isDemo) return { ok: true, via: "demo", plan: null, seats: null };
  if (org.billingExempt) return { ok: true, via: "exempt", plan: null, seats: null };

  const licence = licenseState(org.licenseKey, now);
  if (licence.kind === "licensed") {
    return { ok: true, via: "licence", plan: licence.license.plan, seats: licence.seats };
  }

  if (org.paidThrough && isPlan(org.subscriptionPlan)) {
    const openUntil = org.paidThrough.getTime() + GRACE_DAYS * DAY_MS;
    if (openUntil > now.getTime()) {
      return {
        ok: true,
        via: "subscription",
        plan: org.subscriptionPlan,
        seats: PLANS[org.subscriptionPlan].seats,
      };
    }
  }

  return { ok: false, reason: org.paidThrough || org.licenseKey ? "lapsed" : "never-paid" };
}

export type SeatCheck =
  | { ok: true }
  | { ok: false; limit: number; active: number; message: string };

/**
 * Whether one more active person fits the plan.
 *
 * A check on the step, never on the state: a business can sit above its limit
 * after moving to a smaller plan, and the answer then is to stop the next
 * addition, not to lock out people who were working this morning.
 */
export function canAddPerson(access: Entitlement, activeCount: number): SeatCheck {
  if (!access.ok || access.seats === null || activeCount < access.seats) return { ok: true };

  const plan = access.plan ? `The ${PLANS[access.plan].name} plan` : "Your plan";
  const people = `${access.seats} ${access.seats === 1 ? "person" : "people"}`;

  return {
    ok: false,
    limit: access.seats,
    active: activeCount,
    message: `${plan} covers ${people}, and you have ${activeCount} active. Move to a larger plan, or deactivate someone first.`,
  };
}

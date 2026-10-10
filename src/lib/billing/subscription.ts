import "server-only";

import {
  getSubscription,
  offerPlanReady,
  paypalConfig,
  planForPayPalId,
  startSubscription,
  type PayPalConfig,
  type PayPalInterval,
  type PlanOffer,
  type StartResult,
  type SubscriptionDetails,
} from "@/lib/checkout/paypal";
import { BILLING_PATH } from "./entitlement";
import { launchOfferApplies } from "./launch-offer";
import { trialOfferApplies, type TrialCodeFields } from "./trial-codes";
import { resolveAppUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import type { LicensePlan } from "@/lib/license/token";

/**
 * A business's PayPal subscription, kept in step with PayPal.
 *
 * Two ways in, and both end in syncSubscription(): the buyer coming back from
 * PayPal's approval page, and PayPal's webhook when anything changes later — a
 * renewal, a failed payment, a cancellation. Both ask PayPal where the
 * subscription stands now rather than trusting what they were handed, so the
 * order events arrive in, and how often they are retried, cannot matter.
 */

const MONTHS: Record<PayPalInterval, number> = { monthly: 1, annual: 12 };

/**
 * The end of the period paid for.
 *
 * Only an active subscription moves it. PayPal's next charge date is the end
 * of the period just paid for; when it does not give one, a period is counted
 * from the last payment. Anything else — cancelled, suspended, expired, not
 * yet approved — keeps what was already paid for and adds nothing, which is
 * what lets a cancelled plan run to the end of the month it bought.
 */
export function paidThroughFor(
  details: SubscriptionDetails,
  interval: PayPalInterval,
  current: Date | null,
  now: Date = new Date(),
): Date | null {
  if (details.status !== "ACTIVE") return current;
  if (details.nextBillingTime) return details.nextBillingTime;

  const from = new Date(details.lastPaymentTime ?? now);
  from.setMonth(from.getMonth() + MONTHS[interval]);
  return from;
}

export type SyncResult =
  | { linked: true; organizationId: string; status: string | null; paidThrough: Date | null }
  | {
      linked: false;
      /**
       * not-ours: no business in this deployment started it, or it belongs
       * to another business than the one asking. unreachable: PayPal did not
       * answer.
       */
      reason: "not-configured" | "unreachable" | "not-ours" | "unknown-plan";
    };

/**
 * Brings the business a subscription pays for up to date with it.
 *
 * The business is the one the subscription was started for (its custom_id),
 * or failing that the one already holding it. With expectOrganizationId, a
 * subscription for any other business is refused: the return page must not
 * let one signed-in business claim another's payment by its id.
 */
export async function syncSubscription(
  subscriptionId: string,
  options: { config?: PayPalConfig; expectOrganizationId?: string; now?: Date } = {},
): Promise<SyncResult> {
  const config = options.config ?? paypalConfig();
  if (!config) return { linked: false, reason: "not-configured" };

  const details = await getSubscription(config, subscriptionId);
  if (!details) return { linked: false, reason: "unreachable" };

  const select = {
    id: true,
    subscriptionId: true,
    subscriptionStatus: true,
    paidThrough: true,
    trialEndsAt: true,
  } as const;
  const org = details.customId
    ? await prisma.organization.findUnique({ where: { id: details.customId }, select })
    : await prisma.organization.findUnique({ where: { subscriptionId: details.id }, select });

  if (!org) return { linked: false, reason: "not-ours" };
  if (options.expectOrganizationId && org.id !== options.expectOrganizationId) {
    return { linked: false, reason: "not-ours" };
  }

  const matched = planForPayPalId(config, details.planId);
  if (!matched) {
    console.error(
      `[billing] Subscription ${details.id} is on PayPal plan ${details.planId}, which is not mapped to one of ours.`,
    );
    return { linked: false, reason: "unknown-plan" };
  }

  // A business that has since moved to another subscription ignores news of
  // the old one — its cancellation must not close the plan that replaced it.
  // A newly active subscription always takes over. So does one approved to
  // start later, in place of a plan that is no longer active: that is a
  // business coming back to a plan it cancelled, and until the new one's
  // first payment it keeps the days it had already paid for.
  const replacing = org.subscriptionId !== null && org.subscriptionId !== details.id;
  const takesOver =
    details.status === "ACTIVE" ||
    (details.status === "APPROVED" && org.subscriptionStatus !== "ACTIVE");
  if (replacing && !takesOver) {
    return { linked: true, organizationId: org.id, status: null, paidThrough: org.paidThrough };
  }

  const paidThrough = paidThroughFor(details, matched.interval, org.paidThrough, options.now);

  // The free month's end is its first charge, which is PayPal's next billing
  // date the first time the subscription is seen active. Kept from then on:
  // after that payment the next billing date has moved on a month, and the
  // free month is still the one that ended where it ended.
  const trialEndsAt =
    org.trialEndsAt ??
    (matched.offer === "trial" && details.status === "ACTIVE" ? details.nextBillingTime : null);

  try {
    await prisma.organization.update({
      where: { id: org.id },
      data: {
        subscriptionId: details.id,
        subscriptionStatus: details.status,
        subscriptionPlan: matched.plan,
        subscriptionInterval: matched.interval,
        paidThrough,
        trialEndsAt,
      },
    });
  } catch (error) {
    // The unique index: another business already holds this subscription.
    console.error(`[billing] Could not attach subscription ${details.id} to ${org.id}`, error);
    return { linked: false, reason: "not-ours" };
  }

  return { linked: true, organizationId: org.id, status: details.status, paidThrough };
}

/**
 * Sends a business to PayPal to subscribe.
 *
 * The subscription is started for this business by id, so it can open the
 * account the moment it is approved, and PayPal returns the buyer to the
 * billing screen either way.
 */
export async function startCheckout(input: {
  organizationId: string;
  email: string;
  plan: LicensePlan;
  interval: PayPalInterval;
  /** Take the first payment then rather than now. */
  startAt?: Date | null;
  /** On an offer's plan — see offerFor(). */
  offer?: PlanOffer | null;
}): Promise<StartResult> {
  const config = paypalConfig();
  if (!config) {
    return { ok: false, error: "Payments are not set up on this deployment yet." };
  }

  const appUrl = resolveAppUrl();

  return startSubscription(config, {
    plan: input.plan,
    interval: input.interval,
    returnUrl: `${appUrl}${BILLING_PATH}/return`,
    cancelUrl: `${appUrl}${BILLING_PATH}?cancelled=1`,
    email: input.email,
    customId: input.organizationId,
    startTime: input.startAt ?? null,
    offer: input.offer ?? null,
  });
}

/**
 * Which offer, if any, choosing this plan starts the business on: a free
 * month from the code it entered, or else the launch week's half-price one.
 * The free month wins where both would apply, being the better of the two.
 *
 * The billing screen shows the price by this and the checkout charges by it,
 * so the two cannot disagree. A plan this deployment has no billing plan for
 * on an offer is shown and sold without it, never advertised at a price
 * checkout cannot charge.
 *
 * code: the free-month code the business entered, or null.
 */
export function offerFor(
  org: Parameters<typeof launchOfferApplies>[0],
  code: TrialCodeFields | null,
  config: PayPalConfig | null,
  plan: LicensePlan,
  interval: PayPalInterval,
  now: Date = new Date(),
): PlanOffer | null {
  if (interval !== "monthly") return null;
  if (offerPlanReady(config, plan, "trial") && trialOfferApplies(org, code, now)) return "trial";
  if (offerPlanReady(config, plan, "launch") && launchOfferApplies(org, now)) return "launch";
  return null;
}

/** The free-month code a business entered, as it stands now — or null. */
export async function enteredTrialCode(org: { trialCodeId: string | null }) {
  if (!org.trialCodeId) return null;
  return prisma.trialCode.findUnique({ where: { id: org.trialCodeId } });
}

/**
 * When a business choosing a plan should first be charged.
 *
 * Straight away, unless it still has paid-for time left on a plan that is no
 * longer renewing — cancelled, most often. Then the new plan starts when that
 * time runs out, so the same days are not paid for twice. An hour's margin,
 * because PayPal refuses a start time that has passed by the time it reads it.
 */
export function restartDate(
  org: { subscriptionStatus: string | null; paidThrough: Date | null },
  now: Date = new Date(),
): Date | null {
  if (org.subscriptionStatus === "ACTIVE" || !org.paidThrough) return null;
  return org.paidThrough.getTime() > now.getTime() + 60 * 60 * 1000 ? org.paidThrough : null;
}

/** Statuses a business can cancel from the billing page. */
export const CANCELLABLE = new Set(["ACTIVE", "SUSPENDED", "APPROVED"]);

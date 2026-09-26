import "server-only";

import {
  getSubscription,
  paypalConfig,
  planForPayPalId,
  startSubscription,
  type PayPalConfig,
  type PayPalInterval,
  type StartResult,
  type SubscriptionDetails,
} from "@/lib/checkout/paypal";
import { BILLING_PATH } from "./entitlement";
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
       * not-ours: no business in this deployment started it — it is the
       * anonymous purchase that emails a key, or it belongs to another
       * business than the one asking. unreachable: PayPal did not answer.
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

  const select = { id: true, subscriptionId: true, paidThrough: true } as const;
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
  // A newly active subscription always takes over.
  const replacing = org.subscriptionId !== null && org.subscriptionId !== details.id;
  if (replacing && details.status !== "ACTIVE") {
    return { linked: true, organizationId: org.id, status: null, paidThrough: org.paidThrough };
  }

  const paidThrough = paidThroughFor(
    details,
    matched.interval,
    replacing ? null : org.paidThrough,
    options.now,
  );

  try {
    await prisma.organization.update({
      where: { id: org.id },
      data: {
        subscriptionId: details.id,
        subscriptionStatus: details.status,
        subscriptionPlan: matched.plan,
        subscriptionInterval: matched.interval,
        paidThrough,
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
  });
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { failed, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { BILLING_PATH } from "@/lib/billing/entitlement";
import {
  CANCELLABLE,
  enteredTrialCode,
  offerFor,
  restartDate,
  startCheckout,
} from "@/lib/billing/subscription";
import { applyTrialCode } from "@/lib/billing/trial-code-store";
import { APPLY_REFUSALS } from "@/lib/billing/trial-codes";
import { isPlan } from "@/lib/checkout/plans";
import { cancelSubscription, paypalConfig, revisePlan } from "@/lib/checkout/paypal";
import { resolveAppUrl } from "@/lib/config";
import { prisma } from "@/lib/db";

/**
 * Choosing a plan: off to PayPal to approve it, and back to the billing
 * screen's return page afterwards.
 *
 * Reachable unpaid — it is how a business pays — and only by whoever manages
 * settings, since it commits the business to a charge.
 *
 * A business already paying on an active subscription changes that one
 * rather than starting another beside it, which would bill it twice.
 *
 * A first plan chosen by the month starts on an offer's plan where one
 * applies — the free month from a code the business entered, or the launch
 * week's half-price month — at the price the billing screen showed.
 */
export async function choosePlan(formData: FormData) {
  const { user, org } = await requirePermission("settings:write", { unpaid: "allow" });

  const plan = formData.get("plan");
  const interval = formData.get("interval");
  if (!isPlan(plan) || (interval !== "monthly" && interval !== "annual")) {
    redirect(`${BILLING_PATH}?error=plan`);
  }

  const config = paypalConfig();
  const appUrl = resolveAppUrl();
  const code = await enteredTrialCode(org);

  const result =
    config && org.subscriptionId && org.subscriptionStatus === "ACTIVE"
      ? await revisePlan(config, {
          subscriptionId: org.subscriptionId,
          plan,
          interval,
          returnUrl: `${appUrl}${BILLING_PATH}/return?subscription_id=${encodeURIComponent(org.subscriptionId)}`,
          cancelUrl: `${appUrl}${BILLING_PATH}?cancelled=1`,
        })
      : await startCheckout({
          organizationId: org.id,
          email: user.email,
          plan,
          interval,
          startAt: restartDate(org),
          offer: offerFor(org, code, config, plan, interval),
        });

  // A code, not PayPal's words. The screen shows fixed text for each, so a
  // link cannot be made to put a message of somebody else's choosing in
  // front of a signed-in owner. The detail goes to the log.
  if (!result.ok) {
    console.error(`[billing] Could not start checkout for ${org.id}: ${result.error}`);
    redirect(`${BILLING_PATH}?error=${config ? "paypal" : "setup"}`);
  }

  redirect(result.approveUrl);
}

/**
 * Cancelling the plan, from the billing page rather than PayPal's.
 *
 * Stops the payments and nothing else: the business stays open to the end of
 * what it paid for, and everything in it is kept. Only whoever manages
 * settings, like choosing a plan.
 */
export async function cancelPlan() {
  const { org } = await requirePermission("settings:write", { unpaid: "allow" });

  const config = paypalConfig();
  if (!config || !org.subscriptionId || !CANCELLABLE.has(org.subscriptionStatus ?? "")) {
    redirect(BILLING_PATH);
  }

  const result = await cancelSubscription(
    config,
    org.subscriptionId,
    "Cancelled by the business from Matlock One's billing page.",
  );

  if (!result.ok) {
    console.error(`[billing] Could not cancel ${org.subscriptionId} for ${org.id}: ${result.error}`);
    redirect(`${BILLING_PATH}?error=cancel`);
  }

  // PayPal has it cancelled; say so here at once rather than waiting for the
  // webhook, which will arrive and agree. paidThrough is left alone — that is
  // the time already paid for. Matched on the subscription too, so a plan
  // changed in the meantime is not the one marked.
  await prisma.organization.updateMany({
    where: { id: org.id, subscriptionId: org.subscriptionId },
    data: { subscriptionStatus: "CANCELLED" },
  });

  redirect(`${BILLING_PATH}?plan_cancelled=1`);
}

/**
 * Entering a free-month code. Kept on the business until it chooses a plan,
 * which is when the free month is given; the plan cards say so meanwhile.
 *
 * Only whoever manages settings, like choosing a plan, and only a business
 * that has never had a plan.
 */
export async function enterTrialCode(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { org } = await requirePermission("settings:write", { unpaid: "allow" });

  const typed = text(formData, "code");
  if (!typed) return failed("Type the code first.");

  const refusal = await applyTrialCode(org, typed);
  if (refusal) return failed(APPLY_REFUSALS[refusal]);

  revalidatePath(BILLING_PATH);
  return saved("Code accepted.");
}

/** Taking the code back off, before a plan is chosen. */
export async function removeTrialCode() {
  const { org } = await requirePermission("settings:write", { unpaid: "allow" });

  // Only while no plan has been chosen: afterwards the code is the record of
  // how the business came in, not something to change.
  await prisma.organization.updateMany({
    where: { id: org.id, subscriptionId: null },
    data: { trialCodeId: null },
  });

  redirect(BILLING_PATH);
}

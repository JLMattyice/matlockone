"use server";

import { redirect } from "next/navigation";

import { requirePermission } from "@/lib/auth";
import { BILLING_PATH } from "@/lib/billing/entitlement";
import { startCheckout } from "@/lib/billing/subscription";
import { isPlan } from "@/lib/checkout/plans";
import { paypalConfig, revisePlan } from "@/lib/checkout/paypal";
import { resolveAppUrl } from "@/lib/config";

/**
 * Choosing a plan: off to PayPal to approve it, and back to the billing
 * screen's return page afterwards.
 *
 * Reachable unpaid — it is how a business pays — and only by whoever manages
 * settings, since it commits the business to a charge.
 *
 * A business already paying on an active subscription changes that one
 * rather than starting another beside it, which would bill it twice.
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

  const result =
    config && org.subscriptionId && org.subscriptionStatus === "ACTIVE"
      ? await revisePlan(config, {
          subscriptionId: org.subscriptionId,
          plan,
          interval,
          returnUrl: `${appUrl}${BILLING_PATH}/return?subscription_id=${encodeURIComponent(org.subscriptionId)}`,
          cancelUrl: `${appUrl}${BILLING_PATH}?cancelled=1`,
        })
      : await startCheckout({ organizationId: org.id, email: user.email, plan, interval });

  // A code, not PayPal's words. The screen shows fixed text for each, so a
  // link cannot be made to put a message of somebody else's choosing in
  // front of a signed-in owner. The detail goes to the log.
  if (!result.ok) {
    console.error(`[billing] Could not start checkout for ${org.id}: ${result.error}`);
    redirect(`${BILLING_PATH}?error=${config ? "paypal" : "setup"}`);
  }

  redirect(result.approveUrl);
}

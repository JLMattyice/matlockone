import "server-only";

import { applyRefusal, freeMonthEnds, normalizeTrialCode, type ApplyRefusal } from "./trial-codes";
import { prisma } from "@/lib/db";
import type { LicensePlan } from "@/lib/license/token";

/**
 * Puts a free-month code on a business: from the billing screen, or from a
 * sign-up link that carried one. Returns why it was refused, or null once it
 * is on.
 *
 * A business holds one code at a time; entering another replaces the first,
 * which frees the room it took up under that code's limit.
 */
export async function applyTrialCode(
  org: {
    id: string;
    subscriptionId: string | null;
    trialEndsAt: Date | null;
    isDemo: boolean;
    billingExempt: boolean;
  },
  typed: string,
): Promise<ApplyRefusal | null> {
  const code = normalizeTrialCode(typed);
  const found = code ? await prisma.trialCode.findUnique({ where: { code } }) : null;

  const usesByOthers = found
    ? await prisma.organization.count({ where: { trialCodeId: found.id, id: { not: org.id } } })
    : 0;

  const refusal = applyRefusal(org, found, usesByOthers);
  if (refusal || !found) return refusal ?? "unknown";

  // Matched on subscriptionId too, so a plan chosen in another tab a moment
  // ago is not given a code after the fact.
  const { count } = await prisma.organization.updateMany({
    where: { id: org.id, subscriptionId: null, trialEndsAt: null },
    data: { trialCodeId: found.id },
  });
  return count === 1 ? null : "not-first";
}

/**
 * Opens a business on a plan for a free month, from a code it holds. No
 * subscription and no payment: the month is paidThrough, which is what the
 * lock reads, and trialEndsAt says it was a free one.
 *
 * Matched on never having had a subscription or a free month, so two clicks
 * or two tabs cannot start a second one. Returns whether it started.
 */
export async function startFreeMonth(
  org: { id: string },
  plan: LicensePlan,
  now: Date = new Date(),
): Promise<boolean> {
  const ends = freeMonthEnds(now);
  const { count } = await prisma.organization.updateMany({
    where: { id: org.id, subscriptionId: null, trialEndsAt: null, isDemo: false, billingExempt: false },
    data: {
      subscriptionPlan: plan,
      subscriptionInterval: null,
      subscriptionStatus: null,
      paidThrough: ends,
      trialEndsAt: ends,
    },
  });
  return count === 1;
}

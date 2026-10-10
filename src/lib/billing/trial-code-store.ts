import "server-only";

import { applyRefusal, normalizeTrialCode, type ApplyRefusal } from "./trial-codes";
import { prisma } from "@/lib/db";

/**
 * Puts a free-month code on a business: from the billing screen, or from a
 * sign-up link that carried one. Returns why it was refused, or null once it
 * is on.
 *
 * A business holds one code at a time; entering another replaces the first,
 * which frees the room it took up under that code's limit.
 */
export async function applyTrialCode(
  org: { id: string; subscriptionId: string | null; isDemo: boolean; billingExempt: boolean },
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
    where: { id: org.id, subscriptionId: null },
    data: { trialCodeId: found.id },
  });
  return count === 1 ? null : "not-first";
}

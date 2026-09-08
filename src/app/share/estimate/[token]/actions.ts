"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { effectiveEstimateStatus } from "@/lib/documents";

/**
 * Actions on the public estimate link.
 *
 * These run with no session, so the token *is* the credential. Every function
 * therefore takes only a token — never a record id — looks the estimate up by
 * it, and refuses anything that is not currently open. Nothing here accepts a
 * price, a status or an organization from the caller.
 */

export async function markEstimateViewed(token: string) {
  if (!token) return;

  const estimate = await prisma.estimate.findUnique({
    where: { publicToken: token },
    select: { id: true, status: true, viewedAt: true, expiresAt: true },
  });
  if (!estimate) return;

  // Only the first open counts, and only for an estimate that is actually out
  // for a decision — reopening an accepted quote must not reset its status.
  if (estimate.viewedAt || estimate.status !== "SENT") return;
  if (effectiveEstimateStatus(estimate) === "EXPIRED") return;

  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { status: "VIEWED", viewedAt: new Date() },
  });

  revalidatePath(`/estimates/${estimate.id}`);
  revalidatePath("/estimates");
}

export type RespondResult = { ok: boolean; error?: string };

export async function respondToEstimate(
  token: string,
  decision: "ACCEPTED" | "DECLINED",
  reason?: string,
): Promise<RespondResult> {
  if (!token) return { ok: false, error: "This link is no longer valid." };

  const estimate = await prisma.estimate.findUnique({
    where: { publicToken: token },
    select: { id: true, status: true, expiresAt: true },
  });
  if (!estimate) return { ok: false, error: "This link is no longer valid." };

  const status = effectiveEstimateStatus(estimate);

  if (status === "EXPIRED") {
    return {
      ok: false,
      error: "This estimate has expired. Please contact us for an updated quote.",
    };
  }

  if (status === "ACCEPTED" || status === "DECLINED") {
    return {
      ok: false,
      error: `This estimate was already ${status.toLowerCase()}.`,
    };
  }

  if (status === "DRAFT") {
    return { ok: false, error: "This estimate is not ready yet." };
  }

  const now = new Date();

  await prisma.estimate.update({
    where: { id: estimate.id },
    data:
      decision === "ACCEPTED"
        ? { status: "ACCEPTED", acceptedAt: now, viewedAt: now }
        : {
            status: "DECLINED",
            declinedAt: now,
            viewedAt: now,
            declineReason: reason?.trim()?.slice(0, 500) || null,
          },
  });

  revalidatePath(`/share/estimate/${token}`);
  revalidatePath(`/estimates/${estimate.id}`);
  revalidatePath("/estimates");

  return { ok: true };
}

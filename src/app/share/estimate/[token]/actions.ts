"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { effectiveEstimateStatus } from "@/lib/documents";
import { retryAfterPhrase } from "@/lib/rate-limit";
import { shareAllowed, shareMissed } from "@/lib/share-guard";

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

  // A server action is callable with any token, not only from the page, so it
  // carries the same limit as the page does.
  if (!(await shareAllowed()).ok) return;

  const estimate = await prisma.estimate.findUnique({
    where: { publicToken: token },
    select: {
      id: true,
      status: true,
      viewedAt: true,
      expiresAt: true,
      organization: { select: { isDemo: true } },
    },
  });
  if (!estimate) {
    await shareMissed();
    return;
  }

  // Opening a demo estimate's link records nothing; the demo stays as seeded.
  if (estimate.organization.isDemo) return;

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

  const allowed = await shareAllowed();
  if (!allowed.ok) {
    return {
      ok: false,
      error: `Too many links that don’t exist have been tried from your network. Try again ${retryAfterPhrase(allowed.retryAfterSeconds)}.`,
    };
  }

  const estimate = await prisma.estimate.findUnique({
    where: { publicToken: token },
    select: { id: true, status: true, expiresAt: true, organization: { select: { isDemo: true } } },
  });
  if (!estimate) {
    await shareMissed();
    return { ok: false, error: "This link is no longer valid." };
  }

  if (estimate.organization.isDemo) {
    return {
      ok: false,
      error: "This is a demo estimate, so your answer isn’t recorded. Create your account to send estimates of your own.",
    };
  }

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

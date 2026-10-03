"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { record } from "@/lib/activity";
import { isRole } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { effectiveEstimateStatus } from "@/lib/documents";
import {
  cleanSignatureName,
  requestAddress,
  signedSnapshot,
  snapshotHash,
} from "@/lib/estimate-signature";
import { formatMoney } from "@/lib/money";
import { notify } from "@/lib/notifications";
import { can } from "@/lib/permissions";
import {
  createStageInvoice,
  ESTIMATE_BILLING_SELECT,
  ORG_BILLING_SELECT,
} from "@/lib/progress-billing";
import { sendToQuickBooksSoon } from "@/lib/quickbooks/sync";
import { retryAfterPhrase } from "@/lib/rate-limit";
import { shareAllowed, shareMissed } from "@/lib/share-guard";
import { runEventWorkflows } from "@/lib/workflows/run";

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

/** The deposit invoice for an estimate that asks for one, made as sent. */
async function billDepositOnAcceptance(estimateId: string, organizationId: string) {
  const estimate = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: ESTIMATE_BILLING_SELECT,
  });
  if (!estimate || estimate.depositCents <= 0) return null;

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: ORG_BILLING_SELECT,
  });

  try {
    const created = await prisma.$transaction((tx) =>
      createStageInvoice(tx, {
        org,
        estimate,
        request: { stage: "DEPOSIT" },
        createdById: null,
        sent: true,
      }),
    );
    await sendToQuickBooksSoon(organizationId, { invoices: [created.id] }).catch(() => {});
    return { number: created.number, amount: formatMoney(estimate.depositCents, org.currency, org.locale) };
  } catch (error) {
    // The acceptance stands either way; the office can bill the deposit
    // from the estimate's Billing card.
    console.error(`[estimates] could not bill the deposit on ${estimateId}:`, error);
    return null;
  }
}

/** Who hears that a customer answered: everyone who works on estimates, and whoever wrote it. */
async function whoHears(organizationId: string, createdById: string | null) {
  const people = await prisma.user.findMany({
    where: { organizationId, isActive: true },
    select: { id: true, role: true },
  });
  return people
    .filter(
      (person) =>
        person.id === createdById ||
        (isRole(person.role) && can({ role: person.role, id: person.id }, "estimates:write")),
    )
    .map((person) => person.id);
}

/**
 * The customer accepts or declines. Accepting takes a signature: the name
 * they typed and their tick against "I agree". The office hears either way,
 * and an acceptance starts the "quote accepted" automation just as marking
 * it accepted in the office does.
 */
export async function respondToEstimate(
  token: string,
  decision: "ACCEPTED" | "DECLINED",
  answer: { reason?: string; signature?: { name: string; agreed: boolean } } = {},
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
    select: {
      id: true,
      organizationId: true,
      number: true,
      title: true,
      status: true,
      issueDate: true,
      expiresAt: true,
      subtotalCents: true,
      discountCents: true,
      taxRateBp: true,
      taxCents: true,
      totalCents: true,
      depositCents: true,
      notes: true,
      terms: true,
      clientId: true,
      createdById: true,
      client: { select: { displayName: true } },
      lineItems: {
        orderBy: { sortOrder: "asc" },
        select: {
          name: true,
          description: true,
          quantity: true,
          unit: true,
          unitPriceCents: true,
          totalCents: true,
        },
      },
      organization: { select: { isDemo: true, labelEstimateSingular: true, estimateFooter: true } },
    },
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
  const accepted = decision === "ACCEPTED";
  let signer = "";

  if (accepted) {
    const name = cleanSignatureName(answer.signature?.name);
    if (!name) return { ok: false, error: "Type your full name to sign." };
    if (answer.signature?.agreed !== true) {
      return { ok: false, error: "Tick the box to agree to this estimate." };
    }
    signer = name;

    const request = await headers();
    // The terms as the page showed them: the estimate's own, else the
    // business's standard footer.
    const snapshot = signedSnapshot({
      ...estimate,
      terms: estimate.terms ?? estimate.organization.estimateFooter,
    });

    // Only an estimate still out for a decision changes: two taps of Accept,
    // or an answer racing the office, cannot sign it twice.
    const { count } = await prisma.estimate.updateMany({
      where: { id: estimate.id, status: { in: ["SENT", "VIEWED"] } },
      data: {
        status: "ACCEPTED",
        acceptedAt: now,
        viewedAt: now,
        signedName: name,
        signedAt: now,
        signedIp: requestAddress(request),
        signedUserAgent: request.get("user-agent")?.slice(0, 300) ?? null,
        signedHash: snapshotHash(snapshot),
        signedSnapshot: snapshot,
      },
    });
    if (count === 0) return { ok: false, error: "This estimate was already answered." };
  } else {
    const { count } = await prisma.estimate.updateMany({
      where: { id: estimate.id, status: { in: ["SENT", "VIEWED"] } },
      data: {
        status: "DECLINED",
        declinedAt: now,
        viewedAt: now,
        declineReason: answer.reason?.trim()?.slice(0, 500) || null,
      },
    });
    if (count === 0) return { ok: false, error: "This estimate was already answered." };
  }

  const label = estimate.organization.labelEstimateSingular;
  const customer = estimate.client.displayName;

  // A deposit asked for is billed the moment it is agreed to, ready for the
  // customer to pay from the page they are on.
  let depositNote = "";
  if (accepted) {
    const deposit = await billDepositOnAcceptance(estimate.id, estimate.organizationId);
    if (deposit) depositNote = ` Their deposit invoice ${deposit.number} (${deposit.amount}) is ready for them to pay.`;
  }

  await record({
    organizationId: estimate.organizationId,
    userId: null,
    action: accepted ? "estimate.accepted" : "estimate.declined",
    entityType: "ESTIMATE",
    entityId: estimate.id,
    summary: accepted
      ? `${label} ${estimate.number} accepted and signed by ${signer}`
      : `${label} ${estimate.number} declined by ${customer}`,
  });

  await notify({
    organizationId: estimate.organizationId,
    userIds: await whoHears(estimate.organizationId, estimate.createdById),
    type: "ESTIMATE_RESPONSE",
    title: accepted
      ? `${customer} accepted ${label.toLowerCase()} ${estimate.number}`
      : `${customer} declined ${label.toLowerCase()} ${estimate.number}`,
    body: accepted ? `Signed by ${signer}.${depositNote}` : answer.reason?.trim()?.slice(0, 500) || null,
    entityType: "ESTIMATE",
    entityId: estimate.id,
    actionUrl: `/estimates/${estimate.id}`,
  });

  if (accepted) {
    await runEventWorkflows("estimate.accepted", {
      organizationId: estimate.organizationId,
      entityType: "ESTIMATE",
      entityId: estimate.id,
      subject: customer,
      document: estimate.number,
      clientId: estimate.clientId,
    });
  }

  revalidatePath(`/share/estimate/${token}`);
  revalidatePath(`/estimates/${estimate.id}`);
  revalidatePath("/estimates");

  return { ok: true };
}

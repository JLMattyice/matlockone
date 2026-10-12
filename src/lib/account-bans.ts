import "server-only";

import { BAN_REASON_MAX } from "./account-bans-limits";
import { turnOffAllAutopay } from "./autopay";
import { CANCELLABLE } from "./billing/subscription";
import { cancelSubscription, paypalConfig, type CancelResult } from "./checkout/paypal";
import { prisma } from "./db";
import { removeFile } from "./storage";

/**
 * Banning and deleting a business, for the operator, from the Accounts page.
 *
 * A ban is the one to reach for when a business breaks the terms: it shuts
 * the business at once and keeps everything, so it can be lifted again. Its
 * people are signed out everywhere and cannot sign back in, its customers'
 * links stop answering, every scheduled run passes it by (they all ask
 * entitlement(), which a ban closes), and its plan with Matlock One is
 * cancelled so it is not charged for a business it cannot open. Its emails
 * stay taken, so the same people cannot sign up again with them.
 *
 * Deleting removes the business and everything in it, files included, and
 * cannot be undone. Its emails are freed with it.
 *
 * Neither can touch the demo, or the business the operator is signed in to.
 */

export { BAN_REASON_MAX };

/** Stops a Matlock One plan at PayPal; null when PayPal is not set up here. */
export type StopBilling = (subscriptionId: string, reason: string) => Promise<CancelResult | null>;

const stopAtPayPal: StopBilling = async (subscriptionId, reason) => {
  const config = paypalConfig();
  return config ? cancelSubscription(config, subscriptionId, reason) : null;
};

type Target = {
  organizationId: string;
  /** The business the operator is signed in to, which is never a target. */
  operatorOrganizationId: string;
};

type Refusal = { ok: false; error: string };

async function findTarget({ organizationId, operatorOrganizationId }: Target) {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) return { ok: false, error: "That business no longer exists." } as Refusal;
  if (org.isDemo) return { ok: false, error: "The demo can’t be banned or deleted." } as Refusal;
  if (org.id === operatorOrganizationId) {
    return { ok: false, error: "That’s the business you’re signed in to." } as Refusal;
  }
  return { ok: true as const, org };
}

/**
 * Stops the business's plan with Matlock One, if it has one that could still
 * charge. "none" when there was nothing to stop.
 */
async function stopPlan(
  org: { id: string; subscriptionId: string | null; subscriptionStatus: string | null },
  reason: string,
  stopBilling: StopBilling,
): Promise<"none" | "stopped" | { error: string }> {
  if (!org.subscriptionId || !CANCELLABLE.has(org.subscriptionStatus ?? "")) return "none";

  const result = await stopBilling(org.subscriptionId, reason);
  if (!result) return { error: "PayPal isn’t set up on this server." };
  if (!result.ok) return { error: result.error };

  await prisma.organization.updateMany({
    where: { id: org.id, subscriptionId: org.subscriptionId },
    data: { subscriptionStatus: "CANCELLED" },
  });
  return "stopped";
}

export type BanResult =
  | {
      ok: true;
      /** Whether its plan was cancelled, there was none, or PayPal said no. */
      billing: "none" | "stopped" | { error: string; subscriptionId: string };
    }
  | Refusal;

export async function banBusiness(
  input: Target & { reason: string; now?: Date; stopBilling?: StopBilling },
): Promise<BanResult> {
  const found = await findTarget(input);
  if (!found.ok) return found;
  const { org } = found;

  const reason = input.reason.trim().slice(0, BAN_REASON_MAX);
  if (!reason) return { ok: false, error: "Say why, so you have it on record." };

  // Locked first, so nothing that follows — PayPal being slow, or saying no —
  // leaves it open.
  await prisma.organization.update({
    where: { id: org.id },
    data: { bannedAt: input.now ?? new Date(), banReason: reason },
  });
  await prisma.session.deleteMany({ where: { user: { organizationId: org.id } } });

  const billing = await stopPlan(
    org,
    "Account closed by Matlock One for breaking the terms of service.",
    input.stopBilling ?? stopAtPayPal,
  );

  await prisma.auditLog.create({
    data: {
      organizationId: org.id,
      action: "account.banned",
      entityType: "Organization",
      entityId: org.id,
      summary: `Banned by Matlock One: ${reason}`,
    },
  });

  if (typeof billing === "object") {
    console.error(`[accounts] Banned ${org.id}, but could not cancel ${org.subscriptionId}: ${billing.error}`);
    return { ok: true, billing: { ...billing, subscriptionId: org.subscriptionId! } };
  }
  return { ok: true, billing };
}

/**
 * Reopens a banned business as it was left. Its plan stays cancelled: it runs
 * to the end of what was paid for, and after that the business chooses a plan
 * again like any other.
 */
export async function liftBan(input: Target): Promise<{ ok: true } | Refusal> {
  const found = await findTarget(input);
  if (!found.ok) return found;
  const { org } = found;
  if (!org.bannedAt) return { ok: true };

  await prisma.organization.update({
    where: { id: org.id },
    data: { bannedAt: null, banReason: null },
  });
  await prisma.auditLog.create({
    data: {
      organizationId: org.id,
      action: "account.unbanned",
      entityType: "Organization",
      entityId: org.id,
      summary: "Ban lifted by Matlock One.",
    },
  });
  return { ok: true };
}

export type DeleteResult =
  | {
      ok: true;
      name: string;
      /** Customers' auto-pay PayPal would not cancel, to be stopped by hand. */
      autopayLeft: number;
      /** Files the store would not remove; harmless, but taking up room. */
      filesLeft: number;
    }
  | Refusal;

/**
 * Deletes the business and everything in it. Refused while its plan with
 * Matlock One could still charge and PayPal will not cancel it: once the
 * business is gone there would be nothing here to cancel it from.
 */
export async function deleteBusiness(
  input: Target & { stopBilling?: StopBilling },
): Promise<DeleteResult> {
  const found = await findTarget(input);
  if (!found.ok) return found;
  const { org } = found;

  const billing = await stopPlan(
    org,
    "Account deleted by Matlock One.",
    input.stopBilling ?? stopAtPayPal,
  );
  if (typeof billing === "object") {
    return {
      ok: false,
      error: `PayPal wouldn’t cancel its plan (${billing.error}), so nothing was deleted. Cancel subscription ${org.subscriptionId} in PayPal, then try again.`,
    };
  }

  const autopay = await turnOffAllAutopay(org.id, "The business closed its Matlock One account.");

  const files = await prisma.attachment.findMany({
    where: { organizationId: org.id },
    select: { storagePath: true },
  });

  // Every row hangs off the business and goes with it.
  await prisma.organization.delete({ where: { id: org.id } });

  let filesLeft = 0;
  for (let i = 0; i < files.length; i += 20) {
    const batch = files.slice(i, i + 20);
    const removed = await Promise.allSettled(batch.map((file) => removeFile(file.storagePath)));
    filesLeft += removed.filter((outcome) => outcome.status === "rejected").length;
  }

  console.info(`[accounts] Deleted business ${org.id} (${org.name}), ${files.length} files.`);
  return { ok: true, name: org.name, autopayLeft: autopay.failed, filesLeft };
}

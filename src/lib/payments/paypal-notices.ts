import "server-only";

import { syncAutopay } from "../autopay";
import { entitlement } from "../billing/entitlement";
import { prisma } from "../db";
import { resolveProcessor } from "./account";
import type { PaypalNotice } from "./paypal-webhooks";
import { reconcileInvoice } from "./reconcile";

/**
 * Acting on a PayPal notice for one business.
 *
 * The answer decides what PayPal is told, and PayPal resends anything that is
 * not a success for up to three days. So "retry" is only for PayPal being
 * unreachable, where asking again later can help. Everything else — an invoice
 * that is not ours, a business that has switched processors — is acknowledged,
 * because retrying cannot change it.
 */
export type NoticeOutcome = "recorded" | "nothing-new" | "ignored" | "retry";

export async function handlePaypalNotice(
  organizationId: string,
  notice: PaypalNotice,
): Promise<NoticeOutcome> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  // A locked business's payments wait at PayPal and are written in by the
  // morning run once it reopens, as auto-pay's are.
  if (!org || org.isDemo || !entitlement(org).ok) return "ignored";

  if (notice.kind === "subscription") {
    const subscription = await prisma.autopaySubscription.findFirst({
      where: { organizationId, externalId: notice.subscriptionId },
      select: { scheduleId: true },
    });
    if (!subscription) return "ignored";

    const synced = await syncAutopay({ organizationId, scheduleId: subscription.scheduleId });
    if (synced.failed.length > 0) return "retry";
    return synced.collected > 0 ? "recorded" : "nothing-new";
  }

  const processor = await resolveProcessor(organizationId);
  if (!processor || processor.provider !== "PAYPAL") return "ignored";

  const invoice = await prisma.invoice.findFirst({
    where: { organizationId, paymentRef: notice.paypalInvoiceId },
    select: { id: true },
  });
  if (!invoice) return "ignored";

  const outcome = await reconcileInvoice({
    organizationId,
    invoiceId: invoice.id,
    userId: null,
    processor,
  });

  if (!outcome.ok) return outcome.retry ? "retry" : "ignored";
  return outcome.recorded > 0 ? "recorded" : "nothing-new";
}

import "server-only";

import { prisma } from "@/lib/db";
import { resolveProcessor } from "./account";
import type { Organization } from "@/generated/prisma/client";

/**
 * Putting a payable address on an invoice.
 *
 * Lives here rather than in the invoices actions file because two callers want
 * it: the "Add pay link" button, and sending the invoice — which attaches one
 * automatically so the email a client opens can actually be paid from.
 */

export type InvoiceForLink = {
  id: string;
  number: string;
  title: string | null;
  status: string;
  balanceCents: number;
  paymentUrl: string | null;
  client: { displayName: string; email: string | null };
};

export type LinkOutcome =
  | { ok: true; url: string; alreadyHad: boolean }
  | { ok: false; reason: "no-processor" | "not-payable"; error?: undefined }
  | { ok: false; reason: "failed"; error: string };

/**
 * Whether an invoice is in a state where a pay link means anything.
 *
 * A draft is excluded on purpose and not merely for tidiness: money arriving
 * against one leaves it settled-but-still-draft, because the recalculation
 * deliberately will not move a draft to PAID. Better never to offer the link.
 */
export function canTakePayment(invoice: {
  status: string;
  balanceCents: number;
}) {
  if (invoice.status === "CANCELLED" || invoice.status === "DRAFT") return false;
  return invoice.balanceCents > 0;
}

/**
 * Attaches a pay link, or explains why it could not.
 *
 * Reuses one already on the invoice rather than asking the processor for a
 * second — PayPal would happily create a duplicate invoice, and a client with
 * two links for the same money is how people pay twice.
 */
export async function attachPaymentLink(
  org: Organization,
  invoice: InvoiceForLink,
): Promise<LinkOutcome> {
  if (invoice.paymentUrl) {
    return { ok: true, url: invoice.paymentUrl, alreadyHad: true };
  }

  if (!canTakePayment(invoice)) return { ok: false, reason: "not-payable" };

  const processor = await resolveProcessor(org.id);
  if (!processor) return { ok: false, reason: "no-processor" };

  const result = await processor.adapter.createLink(
    {
      invoiceNumber: invoice.number,
      description: invoice.title ?? `Invoice ${invoice.number}`,
      // Always the outstanding balance: part-payments and deposits mean the
      // total is frequently not what is still owed.
      amountCents: invoice.balanceCents,
      currency: org.currency,
      clientName: invoice.client.displayName,
      clientEmail: invoice.client.email,
      organizationName: org.name,
    },
    processor.config,
    processor.credentials,
  );

  if (!result.ok) return { ok: false, reason: "failed", error: result.error };

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      paymentUrl: result.value.url,
      paymentRef: result.value.ref,
      paymentProvider: processor.provider,
      paymentLinkedAt: new Date(),
      paymentCheckedAt: null,
    },
  });

  return { ok: true, url: result.value.url, alreadyHad: false };
}

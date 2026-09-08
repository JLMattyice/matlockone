import "server-only";

import type { Prisma } from "@/generated/prisma/client";

/**
 * Recomputes an invoice's paid amount, balance and status from its payments.
 *
 * The payment rows are the source of truth; `amountPaidCents` and
 * `balanceCents` are a cached summary of them. Every path that adds, edits or
 * removes a payment — and every path that changes the invoice total — calls
 * this inside the same transaction, so the summary can never drift from the
 * ledger it summarises.
 *
 * Returns the recomputed figures so callers can report them without a re-read.
 */
export async function recalculateInvoice(
  tx: Prisma.TransactionClient,
  invoiceId: string,
) {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      totalCents: true,
      status: true,
      viewedAt: true,
      paidAt: true,
    },
  });
  if (!invoice) return null;

  const paid = await tx.payment.aggregate({
    where: { invoiceId },
    _sum: { amountCents: true },
  });

  const amountPaidCents = paid._sum.amountCents ?? 0;
  const balanceCents = invoice.totalCents - amountPaidCents;
  const settled = balanceCents <= 0 && invoice.totalCents > 0;

  // A draft is not owed yet, and a cancelled invoice stays cancelled even if a
  // payment was recorded against it before someone voided it.
  const locked = invoice.status === "DRAFT" || invoice.status === "CANCELLED";

  const status = locked
    ? invoice.status
    : settled
      ? "PAID"
      : // Removing a payment from a settled invoice has to put it back to
        // whatever the client had last seen, not silently to "sent".
        invoice.status === "PAID"
        ? (invoice.viewedAt ? "VIEWED" : "SENT")
        : invoice.status;

  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      amountPaidCents,
      balanceCents,
      status,
      paidAt: settled && !locked ? (invoice.paidAt ?? new Date()) : null,
    },
  });

  return { amountPaidCents, balanceCents, status, settled };
}

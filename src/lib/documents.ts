import {
  asStatus,
  ESTIMATE_STATUSES,
  INVOICE_STATUSES,
  type EstimateStatus,
  type InvoiceStatus,
} from "./constants";

/**
 * Expiry is derived at read time rather than written to the row.
 *
 * An estimate becomes expired purely by the clock passing its date. Flipping
 * the stored status would mean either a scheduled sweep or a surprise write on
 * every read, and would lose the fact that it was genuinely *sent*. Deriving it
 * keeps the stored status a record of what someone actually did.
 */
export function effectiveEstimateStatus(estimate: {
  status: string;
  expiresAt: Date | null;
}): EstimateStatus {
  const stored = asStatus(ESTIMATE_STATUSES, estimate.status, "DRAFT");

  const stillOpen = stored === "SENT" || stored === "VIEWED";
  if (stillOpen && estimate.expiresAt && estimate.expiresAt.getTime() < Date.now()) {
    return "EXPIRED";
  }

  return stored;
}

/** An estimate the client can still act on. */
export function isEstimateOpen(status: EstimateStatus) {
  return status === "SENT" || status === "VIEWED";
}

/** Statuses whose totals are still "in play" for pipeline reporting. */
export const ESTIMATE_PENDING_STATUSES: EstimateStatus[] = ["SENT", "VIEWED"];

// --------------------------------------------------------------- invoices ---

/**
 * Invoice status is part stored, part derived.
 *
 * DRAFT, SENT, VIEWED, PAID and CANCELLED record something a person did, so
 * they live in the column. PARTIALLY_PAID and OVERDUE are *facts about the
 * money and the calendar* — they follow from the balance and the due date, and
 * would go stale the moment either changed. Deriving them means an invoice can
 * never sit in the database claiming to be current the day after it lapsed.
 */
export function effectiveInvoiceStatus(invoice: {
  status: string;
  dueDate: Date | null;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
}): InvoiceStatus {
  const stored = asStatus(INVOICE_STATUSES, invoice.status, "DRAFT");

  if (stored === "DRAFT" || stored === "CANCELLED") return stored;

  // Settled beats everything else, however it was reached.
  if (invoice.balanceCents <= 0 && invoice.totalCents > 0) return "PAID";

  if (invoice.dueDate && invoice.dueDate.getTime() < Date.now()) {
    return "OVERDUE";
  }

  if (invoice.amountPaidCents > 0) return "PARTIALLY_PAID";

  // A stored PAID/PARTIALLY_PAID/OVERDUE that no longer holds falls back to
  // the last thing the office actually did.
  return stored === "VIEWED" ? "VIEWED" : "SENT";
}

/** Statuses that still owe money once derivation is applied. */
export function invoiceIsOpen(status: InvoiceStatus) {
  return (
    status === "SENT" ||
    status === "VIEWED" ||
    status === "PARTIALLY_PAID" ||
    status === "OVERDUE"
  );
}

/** Receivables ageing bucket for a still-open invoice. */
export function ageingBucket(dueDate: Date | null): "current" | "1-30" | "31-60" | "60+" {
  if (!dueDate) return "current";

  const days = Math.floor((Date.now() - dueDate.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  return "60+";
}

/**
 * Whether an invoice may be deleted outright, and what it costs.
 *
 * A sent or paid invoice is part of the books, and the safe answer for a real
 * business is to cancel rather than delete: the number stays, the trail stays,
 * and nothing downstream develops a hole. That is the default, and it is why
 * deleting was originally restricted to untouched drafts.
 *
 * But it is the *customer's* ledger, and a business setting up will have test
 * invoices it wants gone. So deletion is allowed with the consequence stated
 * plainly, rather than forbidden and worked around by hand in the database.
 */
export function invoiceDeletion(invoice: {
  status: string;
  paymentCount: number;
  amountPaidCents: number;
}): { allowed: boolean; warning: string | null } {
  if (invoice.status === "DRAFT" && invoice.paymentCount === 0) {
    // Never sent, no money against it. Nothing to lose.
    return { allowed: true, warning: null };
  }

  if (invoice.paymentCount > 0) {
    return {
      allowed: true,
      warning:
        invoice.paymentCount === 1
          ? "This deletes the payment recorded against it too, and your income figures will change."
          : `This deletes the ${invoice.paymentCount} payments recorded against it too, and your income figures will change.`,
    };
  }

  if (invoice.status === "CANCELLED") {
    return {
      allowed: true,
      warning: "This invoice is already cancelled. Deleting it removes the record entirely.",
    };
  }

  return {
    allowed: true,
    warning:
      "This invoice has been sent to the client. Deleting it leaves a gap in your numbering — cancelling keeps the trail.",
  };
}

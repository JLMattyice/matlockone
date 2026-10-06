import Link from "next/link";
import { format } from "date-fns";
import { Briefcase, FileText, Pencil, Receipt, Trash2, Wallet } from "lucide-react";

import { deletePayment } from "@/app/(app)/invoices/actions";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/page-header";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import {
  asStatus,
  ESTIMATE_STATUS_META,
  ESTIMATE_STATUSES,
  INVOICE_STATUS_META,
  INVOICE_STATUSES,
  JOB_STATUS_META,
  JOB_STATUSES,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type PaymentMethod,
} from "@/lib/constants";
import { entryCategory } from "@/lib/job-categories";
import { formatMoney } from "@/lib/money";
import { formatIn } from "@/lib/time-zone";

/**
 * History for a client. Every row links through to the record it summarises;
 * payments can also be corrected or deleted from here, by whoever may record
 * them.
 */

type Money = { currency: string; locale: string };

export function JobsTable({
  jobs,
  jobLabel,
  zone,
}: {
  jobs: {
    id: string;
    number: string;
    title: string;
    kind: string;
    category?: { name: string; icon: string } | null;
    status: string;
    scheduledStart: Date | null;
    completedAt: Date | null;
    address: { line1: string; city: string | null } | null;
    assignments: { user: { id: string; name: string } }[];
  }[];
  jobLabel: string;
  /** The viewer's time zone, from viewerTimeZone(). */
  zone: string;
}) {
  if (jobs.length === 0) {
    return (
      <EmptyState
        icon={<Briefcase className="h-5 w-5" strokeWidth={1.75} />}
        title={`No ${jobLabel.toLowerCase()} yet`}
        description="Work scheduled for this client will appear here."
      />
    );
  }

  return (
    <Table>
      <THead>
        <Th>Number</Th>
        <Th>Title</Th>
        <Th className="hidden md:table-cell">Scheduled</Th>
        <Th className="hidden lg:table-cell">Assigned</Th>
        <Th>Status</Th>
      </THead>
      <TBody>
        {jobs.map((job) => {
          const meta = JOB_STATUS_META[asStatus(JOB_STATUSES, job.status, "SCHEDULED")];
          return (
            <Tr key={job.id}>
              <Td className="tabular font-medium whitespace-nowrap">
                <Link
                  href={`/jobs/${job.id}`}
                  className="transition-colors hover:text-brand"
                >
                  {job.number}
                </Link>
              </Td>
              <Td>
                <Link
                  href={`/jobs/${job.id}`}
                  className="block truncate font-medium transition-colors hover:text-brand"
                >
                  {job.title}
                </Link>
                {!entryCategory(job, jobLabel).plain ? (
                  <span className="text-xs text-ink-subtle">
                    {entryCategory(job, jobLabel).label}
                  </span>
                ) : job.address ? (
                  <span className="block truncate text-xs text-ink-subtle">
                    {[job.address.line1, job.address.city]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                ) : null}
              </Td>
              <Td className="tabular hidden whitespace-nowrap text-ink-muted md:table-cell">
                {job.scheduledStart
                  ? formatIn(job.scheduledStart, "MMM d, yyyy · h:mm a", zone)
                  : "—"}
              </Td>
              <Td className="hidden text-ink-muted lg:table-cell">
                <span className="block truncate">
                  {job.assignments.map((a) => a.user.name).join(", ") || "—"}
                </span>
              </Td>
              <Td>
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
}

export function EstimatesTable({
  estimates,
  currency,
  locale,
}: {
  estimates: {
    id: string;
    number: string;
    title: string | null;
    status: string;
    issueDate: Date;
    expiresAt: Date | null;
    totalCents: number;
  }[];
} & Money) {
  if (estimates.length === 0) {
    return (
      <EmptyState
        icon={<FileText className="h-5 w-5" strokeWidth={1.75} />}
        title="No estimates yet"
        description="Quotes sent to this client will appear here."
      />
    );
  }

  return (
    <Table>
      <THead>
        <Th>Number</Th>
        <Th>Description</Th>
        <Th className="hidden md:table-cell">Issued</Th>
        <Th align="right">Total</Th>
        <Th>Status</Th>
      </THead>
      <TBody>
        {estimates.map((estimate) => {
          const meta =
            ESTIMATE_STATUS_META[
              asStatus(ESTIMATE_STATUSES, estimate.status, "DRAFT")
            ];
          return (
            <Tr key={estimate.id}>
              <Td className="tabular font-medium whitespace-nowrap">
                <Link
                  href={`/estimates/${estimate.id}`}
                  className="transition-colors hover:text-brand"
                >
                  {estimate.number}
                </Link>
              </Td>
              <Td>
                <Link
                  href={`/estimates/${estimate.id}`}
                  className="block truncate transition-colors hover:text-brand"
                >
                  {estimate.title ?? "—"}
                </Link>
              </Td>
              <Td className="tabular hidden whitespace-nowrap text-ink-muted md:table-cell">
                {format(estimate.issueDate, "MMM d, yyyy")}
              </Td>
              <Td align="right" className="tabular font-medium whitespace-nowrap">
                {formatMoney(estimate.totalCents, currency, locale)}
              </Td>
              <Td>
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
}

export function InvoicesTable({
  invoices,
  currency,
  locale,
}: {
  invoices: {
    id: string;
    number: string;
    status: string;
    issueDate: Date;
    dueDate: Date | null;
    totalCents: number;
    amountPaidCents: number;
    balanceCents: number;
  }[];
} & Money) {
  if (invoices.length === 0) {
    return (
      <EmptyState
        icon={<Receipt className="h-5 w-5" strokeWidth={1.75} />}
        title="No invoices yet"
        description="Bills raised for this client will appear here."
      />
    );
  }

  return (
    <Table>
      <THead>
        <Th>Number</Th>
        <Th className="hidden md:table-cell">Issued</Th>
        <Th className="hidden sm:table-cell">Due</Th>
        <Th align="right">Total</Th>
        <Th align="right">Balance</Th>
        <Th>Status</Th>
      </THead>
      <TBody>
        {invoices.map((invoice) => {
          const meta =
            INVOICE_STATUS_META[
              asStatus(INVOICE_STATUSES, invoice.status, "DRAFT")
            ];
          const overdue = invoice.status === "OVERDUE";

          return (
            <Tr key={invoice.id}>
              <Td className="tabular font-medium whitespace-nowrap">
                <Link
                  href={`/invoices/${invoice.id}`}
                  className="transition-colors hover:text-brand"
                >
                  {invoice.number}
                </Link>
              </Td>
              <Td className="tabular hidden whitespace-nowrap text-ink-muted md:table-cell">
                {format(invoice.issueDate, "MMM d, yyyy")}
              </Td>
              <Td
                className={`tabular hidden whitespace-nowrap sm:table-cell ${
                  overdue ? "text-danger" : "text-ink-muted"
                }`}
              >
                {invoice.dueDate ? format(invoice.dueDate, "MMM d, yyyy") : "—"}
              </Td>
              <Td align="right" className="tabular whitespace-nowrap">
                {formatMoney(invoice.totalCents, currency, locale)}
              </Td>
              <Td align="right" className="tabular font-medium whitespace-nowrap">
                {invoice.balanceCents > 0 ? (
                  <span className={overdue ? "text-danger" : "text-warning"}>
                    {formatMoney(invoice.balanceCents, currency, locale)}
                  </span>
                ) : (
                  <span className="text-ink-subtle">—</span>
                )}
              </Td>
              <Td>
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
}

export function PaymentsTable({
  payments,
  currency,
  locale,
  zone,
  editFrom,
}: {
  /** The viewer's time zone: a payment taken by a card processor is a moment, not a date. */
  zone: string;
  /**
   * The page to come back to after editing or deleting one — given only to
   * somebody who may record payments, and without it the table is read-only.
   */
  editFrom?: string;
  payments: {
    id: string;
    amountCents: number;
    method: string;
    receivedAt: Date;
    reference: string | null;
    invoice: { id: string; number: string } | null;
  }[];
} & Money) {
  if (payments.length === 0) {
    return (
      <EmptyState
        icon={<Wallet className="h-5 w-5" strokeWidth={1.75} />}
        title="No payments recorded"
        description="Money received from this client will appear here."
      />
    );
  }

  return (
    <Table>
      <THead>
        <Th>Received</Th>
        <Th>Invoice</Th>
        <Th className="hidden sm:table-cell">Method</Th>
        <Th className="hidden lg:table-cell">Reference</Th>
        <Th align="right">Amount</Th>
        {editFrom ? (
          <Th align="right">
            <span className="sr-only">Actions</span>
          </Th>
        ) : null}
      </THead>
      <TBody>
        {payments.map((payment) => (
          <Tr key={payment.id}>
            <Td className="tabular whitespace-nowrap text-ink-muted">
              {formatIn(payment.receivedAt, "MMM d, yyyy", zone)}
            </Td>
            <Td className="tabular font-medium whitespace-nowrap">
              {payment.invoice ? (
                <Link
                  href={`/invoices/${payment.invoice.id}`}
                  className="transition-colors hover:text-brand"
                >
                  {payment.invoice.number}
                </Link>
              ) : (
                "—"
              )}
            </Td>
            <Td className="hidden text-ink-muted sm:table-cell">
              {
                PAYMENT_METHOD_LABELS[
                  asStatus(PAYMENT_METHODS, payment.method, "OTHER") as PaymentMethod
                ]
              }
            </Td>
            <Td className="hidden text-ink-subtle lg:table-cell">
              {payment.reference ?? "—"}
            </Td>
            <Td
              align="right"
              className="tabular font-medium whitespace-nowrap text-success"
            >
              {formatMoney(payment.amountCents, currency, locale)}
            </Td>
            {editFrom ? (
              <Td align="right" className="whitespace-nowrap">
                <div className="flex items-center justify-end gap-1">
                  <Link
                    href={`/payments/${payment.id}/edit?back=${encodeURIComponent(editFrom)}`}
                    aria-label="Edit payment"
                    title="Edit payment"
                    className={buttonClasses("ghost", "sm", "px-2")}
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </Link>
                  <form action={deletePayment}>
                    <input type="hidden" name="id" value={payment.id} />
                    {/* Two clicks: the first turns it red and asks. */}
                    <ConfirmButton
                      variant="ghost"
                      size="sm"
                      className="px-2"
                      confirmLabel="Delete?"
                      pendingLabel="Deleting…"
                      title="Delete payment"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                      <span className="sr-only">Delete payment</span>
                    </ConfirmButton>
                  </form>
                </div>
              </Td>
            ) : null}
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

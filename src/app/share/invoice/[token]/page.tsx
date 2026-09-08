import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { AlertTriangle, Ban, Check, Clock } from "lucide-react";

import { MarkViewed } from "./mark-viewed";
import { getInvoiceByToken } from "@/app/(app)/invoices/queries";
import { DocumentView } from "@/components/documents/document-view";
import { PrintButton } from "@/components/documents/print-button";
import {
  asStatus,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type PaymentMethod,
} from "@/lib/constants";
import { effectiveInvoiceStatus } from "@/lib/documents";
import { formatMoney } from "@/lib/money";
import { hexToRgbChannels } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Your invoice",
  robots: { index: false, follow: false },
};

export default async function PublicInvoicePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invoice = await getInvoiceByToken(token);

  if (!invoice) notFound();

  const org = invoice.organization;
  const status = effectiveInvoiceStatus(invoice);
  const brand = hexToRgbChannels(org.primaryColor) ? org.primaryColor : "#2563eb";
  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);

  // A draft has not been issued to anyone yet; the link should not resolve.
  if (invoice.status === "DRAFT") notFound();

  return (
    <div
      style={{ "--brand": brand } as React.CSSProperties}
      className="min-h-screen bg-surface-2 px-4 py-8 sm:py-12"
    >
      <MarkViewed token={token} />

      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 no-print">
          <div>
            <p className="text-sm text-ink-muted">
              Invoice from <span className="font-medium text-ink">{org.name}</span>
            </p>
            <p className="tabular text-xs text-ink-subtle">{invoice.number}</p>
          </div>
          <PrintButton label="Print or save PDF" />
        </div>

        <StatusBanner
          status={status}
          dueDate={invoice.dueDate}
          balance={money(invoice.balanceCents)}
        />

        {invoice.paymentUrl && invoice.balanceCents > 0 ? (
          <a
            href={invoice.paymentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="no-print flex items-center justify-center rounded-card bg-brand px-5 py-3.5 text-sm font-semibold text-brand-ink shadow-sm transition hover:brightness-110"
          >
            Pay {money(invoice.balanceCents)} online
          </a>
        ) : null}

        <div className="overflow-hidden rounded-card border border-line shadow-xs">
          <DocumentView
            org={org}
            kind="Invoice"
            number={invoice.number}
            title={invoice.title}
            issueDate={invoice.issueDate}
            secondaryDateLabel="Due"
            secondaryDate={invoice.dueDate}
            clientName={invoice.client.displayName}
            address={invoice.address}
            lines={invoice.lineItems}
            totals={{
              subtotalCents: invoice.subtotalCents,
              discountCents: invoice.discountCents,
              taxRateBp: invoice.taxRateBp,
              taxCents: invoice.taxCents,
              totalCents: invoice.totalCents,
              amountPaidCents: invoice.amountPaidCents,
              balanceCents: invoice.balanceCents,
            }}
            notes={invoice.notes}
            terms={invoice.terms ?? org.invoiceFooter}
            currency={org.currency}
            locale={org.locale}
          />
        </div>

        {invoice.payments.length > 0 ? (
          <div className="rounded-card border border-line bg-surface p-5">
            <h2 className="mb-3 text-sm font-semibold text-ink">
              Payments received
            </h2>
            <ul className="divide-y divide-line text-sm">
              {invoice.payments.map((payment) => (
                <li
                  key={payment.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span className="text-ink-muted">
                    {format(payment.receivedAt, "MMMM d, yyyy")} ·{" "}
                    {
                      PAYMENT_METHOD_LABELS[
                        asStatus(
                          PAYMENT_METHODS,
                          payment.method,
                          "OTHER",
                        ) as PaymentMethod
                      ]
                    }
                  </span>
                  <span className="tabular font-medium text-success">
                    {money(payment.amountCents)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <footer className="pt-2 pb-6 text-center text-xs text-ink-subtle no-print">
          Questions about this invoice? Contact {org.name}
          {org.phone ? ` on ${org.phone}` : ""}
          {org.email ? ` or at ${org.email}` : ""}.
        </footer>
      </div>
    </div>
  );
}

function StatusBanner({
  status,
  dueDate,
  balance,
}: {
  status: string;
  dueDate: Date | null;
  balance: string;
}) {
  if (status === "PAID") {
    return (
      <Banner tone="success" icon={<Check className="h-4 w-4" strokeWidth={2.5} />}>
        Paid in full. Thank you.
      </Banner>
    );
  }

  if (status === "CANCELLED") {
    return (
      <Banner tone="neutral" icon={<Ban className="h-4 w-4" strokeWidth={2.5} />}>
        This invoice has been cancelled. Nothing is owed.
      </Banner>
    );
  }

  if (status === "OVERDUE") {
    return (
      <Banner
        tone="danger"
        icon={<AlertTriangle className="h-4 w-4" strokeWidth={2.5} />}
      >
        {balance} was due
        {dueDate ? ` on ${format(dueDate, "MMMM d, yyyy")}` : ""}. Please get in
        touch if you have already sent payment.
      </Banner>
    );
  }

  if (status === "PARTIALLY_PAID") {
    return (
      <Banner tone="info" icon={<Clock className="h-4 w-4" strokeWidth={2.5} />}>
        {balance} remains outstanding
        {dueDate ? `, due ${format(dueDate, "MMMM d, yyyy")}` : ""}.
      </Banner>
    );
  }

  if (dueDate) {
    return (
      <Banner tone="info" icon={<Clock className="h-4 w-4" strokeWidth={2.5} />}>
        {balance} due by {format(dueDate, "MMMM d, yyyy")}.
      </Banner>
    );
  }

  return null;
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: "success" | "danger" | "info" | "neutral";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const classes = {
    success: "border-success/30 bg-success/10 text-success",
    danger: "border-danger/30 bg-danger/10 text-danger",
    info: "border-info/25 bg-info/8 text-info",
    neutral: "border-line bg-surface-3 text-ink-muted",
  }[tone];

  return (
    <div
      className={`flex items-start gap-2.5 rounded-card border px-4 py-3 text-sm ${classes}`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <p>{children}</p>
    </div>
  );
}

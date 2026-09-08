import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { FileText,
  ArrowLeft,
  Ban,
  Briefcase,
  Copy,
  Pencil,
  RotateCcw,
  Trash2,
  Wallet,
} from "lucide-react";

import { PaymentForm, SendInvoice } from "./payment-form";
import {
  deleteInvoice,
  deletePayment,
  duplicateInvoice,
  setInvoiceCancelled,
} from "../actions";
import { getInvoice } from "../queries";
import { CopyLink } from "../../estimates/[id]/estimate-actions";
import { DocumentView } from "@/components/documents/document-view";
import { PrintButton } from "@/components/documents/print-button";
import { NotesPanel } from "@/components/notes/notes-panel";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/page-header";
import { getContext, requirePermission } from "@/lib/auth";
import {
  asStatus,
  INVOICE_STATUS_META,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type PaymentMethod,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import {
  invoiceDeletion,
  effectiveInvoiceStatus } from "@/lib/documents";
import { publicUrl } from "@/lib/messaging";
import { PaymentLinkPanel } from "./payment-link-panel";
import { resolveProcessor } from "@/lib/payments/account";
import { PAYMENT_PROVIDER_META } from "@/lib/payments/catalog";
import { currencySymbol, formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const ctx = await getContext();
  if (!ctx) return { title: "Invoice" };

  const { id } = await params;
  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId: ctx.org.id },
    select: { number: true },
  });

  return { title: invoice ? `Invoice ${invoice.number}` : "Invoice" };
}

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, org } = await requirePermission("invoices:read");
  const { id } = await params;
  const invoice = await getInvoice(org.id, id);

  const status = effectiveInvoiceStatus(invoice);
  const meta = INVOICE_STATUS_META[status];

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const writable = can(user, "invoices:write");
  const sendable = can(user, "invoices:send");
  const canRecord = can(user, "payments:record");

  const cancelled = invoice.status === "CANCELLED";
  const isDraft = invoice.status === "DRAFT";

  // What deleting this one would actually cost, so the confirmation can say so
  // rather than the button simply being missing and unexplained.
  const deletion = invoiceDeletion({
    status: invoice.status,
    paymentCount: invoice.payments.length,
    amountPaidCents: invoice.amountPaidCents,
  });
  const editable = writable && !cancelled && invoice.amountPaidCents === 0;
  const shareUrl = publicUrl(`/share/invoice/${invoice.publicToken}`);

  // Which processor is connected decides what the pay-link panel can offer.
  const processor = await resolveProcessor(org.id);
  const processorMeta = processor
    ? PAYMENT_PROVIDER_META[processor.provider]
    : null;

  return (
    <div className="space-y-6">
      <div className="no-print">
        <Link
          href="/invoices"
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Invoices
        </Link>
      </div>

      <Card className="no-print">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular text-sm font-medium text-ink-subtle">
                {invoice.number}
              </span>
              <Badge tone={meta.tone} dot>
                {meta.label}
              </Badge>
              {invoice.job ? (
                <Link
                  href={`/jobs/${invoice.job.id}`}
                  className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
                >
                  <Briefcase className="h-3 w-3" strokeWidth={2} />
                  {invoice.job.number}
                </Link>
              ) : null}
              {invoice.estimate ? (
                <Link
                  href={`/estimates/${invoice.estimate.id}`}
                  className="text-xs text-brand hover:underline"
                >
                  {invoice.estimate.number}
                </Link>
              ) : null}
            </div>

            <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-ink">
              {invoice.title ?? `Invoice for ${invoice.client.displayName}`}
            </h1>

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
              {invoice.sentAt ? (
                <span>Sent {format(invoice.sentAt, "MMM d, h:mm a")}</span>
              ) : (
                <span>Not sent yet</span>
              )}
              {invoice.viewedAt ? (
                <span>Viewed {format(invoice.viewedAt, "MMM d, h:mm a")}</span>
              ) : null}
              {invoice.paidAt ? (
                <span className="text-success">
                  Paid {format(invoice.paidAt, "MMM d, yyyy")}
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <PrintButton />

            {editable ? (
              <Link
                href={`/invoices/${invoice.id}/edit`}
                className={buttonClasses("outline", "md")}
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                Edit
              </Link>
            ) : null}

            <a
              href={`/invoices/${invoice.id}/pdf`}
              target="_blank"
              rel="noreferrer"
              className={buttonClasses("outline", "md")}
            >
              <FileText className="h-3.5 w-3.5" strokeWidth={2} />
              PDF
            </a>

            {writable ? (
              <form action={duplicateInvoice}>
                <input type="hidden" name="id" value={invoice.id} />
                <button type="submit" className={buttonClasses("outline", "md")}>
                  <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                  Duplicate
                </button>
              </form>
            ) : null}

            {writable && !cancelled ? (
              <form action={setInvoiceCancelled}>
                <input type="hidden" name="id" value={invoice.id} />
                <ConfirmButton
                  variant="ghost"
                  size="md"
                  confirmLabel="Cancel it?"
                >
                  <Ban className="h-3.5 w-3.5" strokeWidth={2} />
                  Cancel
                </ConfirmButton>
              </form>
            ) : null}

            {writable && cancelled ? (
              <form action={setInvoiceCancelled}>
                <input type="hidden" name="id" value={invoice.id} />
                <input type="hidden" name="cancel" value="false" />
                <button type="submit" className={buttonClasses("outline", "md")}>
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
                  Reinstate
                </button>
              </form>
            ) : null}

            {can(user, "invoices:delete") ? (
              <form action={deleteInvoice}>
                <input type="hidden" name="id" value={invoice.id} />
                <ConfirmButton
                  variant="ghost"
                  size="md"
                  confirmLabel={
                    deletion.warning ? "Delete permanently?" : "Delete?"
                  }
                  title={deletion.warning ?? undefined}
                >
                  Delete
                </ConfirmButton>
              </form>
            ) : null}
          </div>
        </div>

        {/* --------------------------------------------------- money strip --- */}
        <div className="grid grid-cols-2 divide-line border-t border-line sm:grid-cols-4 sm:divide-x">
          <Figure label="Total" value={money(invoice.totalCents)} />
          <Figure
            label="Paid"
            value={money(invoice.amountPaidCents)}
            tone={invoice.amountPaidCents > 0 ? "success" : undefined}
          />
          <Figure
            label={invoice.balanceCents < 0 ? "Credit" : "Balance"}
            value={money(Math.abs(invoice.balanceCents))}
            tone={
              invoice.balanceCents > 0
                ? status === "OVERDUE"
                  ? "danger"
                  : "warning"
                : "success"
            }
          />
          <Figure
            label="Due"
            value={invoice.dueDate ? format(invoice.dueDate, "MMM d, yyyy") : "—"}
            tone={status === "OVERDUE" ? "danger" : undefined}
          />
        </div>

        {sendable || canRecord ? (
          <div className="space-y-3 border-t border-line bg-surface-2 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {sendable && !cancelled ? (
                <SendInvoice
                  invoiceId={invoice.id}
                  defaultEmail={invoice.client.email}
                  alreadySent={Boolean(invoice.sentAt)}
                />
              ) : null}
            </div>

            {!isDraft && !cancelled ? (
              <div>
                <p className="mb-1.5 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
                  Client link
                </p>
                <CopyLink url={shareUrl} />
              </div>
            ) : null}

            {!cancelled && writable ? (
              <PaymentLinkPanel
                invoiceId={invoice.id}
                processorLabel={processorMeta?.label ?? null}
                processorReconciles={processorMeta?.reconciles ?? false}
                paymentUrl={invoice.paymentUrl}
                paymentCheckedAt={invoice.paymentCheckedAt?.toISOString() ?? null}
                hasRef={Boolean(invoice.paymentRef)}
                settled={invoice.balanceCents <= 0}
                canRecord={canRecord}
              />
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
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
            terms={invoice.terms}
            currency={org.currency}
            locale={org.locale}
          />
        </Card>

        <div className="space-y-6 no-print">
          <Card className="overflow-hidden">
            <CardHeader
              title="Payments"
              description={
                invoice.balanceCents > 0
                  ? `${money(invoice.balanceCents)} still outstanding`
                  : "Settled in full"
              }
            />

            {canRecord && !cancelled && !isDraft && invoice.balanceCents > 0 ? (
              <div className="border-b border-line p-5">
                <PaymentForm
                  invoiceId={invoice.id}
                  balanceCents={invoice.balanceCents}
                  currencySymbol={currencySymbol(org.currency, org.locale)}
                  today={format(new Date(), "yyyy-MM-dd")}
                />
              </div>
            ) : null}

            {isDraft ? (
              <p className="border-b border-line px-5 py-3 text-xs text-ink-muted">
                Send the invoice before recording payments against it.
              </p>
            ) : null}

            {invoice.payments.length === 0 ? (
              <EmptyState
                icon={<Wallet className="h-5 w-5" strokeWidth={1.75} />}
                title="No payments yet"
              />
            ) : (
              <ul className="divide-y divide-line">
                {invoice.payments.map((payment) => (
                  <li
                    key={payment.id}
                    className="group flex items-start justify-between gap-3 px-5 py-3"
                  >
                    <div className="min-w-0">
                      <p className="tabular text-sm font-medium text-success">
                        {money(payment.amountCents)}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {
                          PAYMENT_METHOD_LABELS[
                            asStatus(
                              PAYMENT_METHODS,
                              payment.method,
                              "OTHER",
                            ) as PaymentMethod
                          ]
                        }{" "}
                        · {format(payment.receivedAt, "MMM d, yyyy")}
                      </p>
                      {payment.reference ? (
                        <p className="truncate text-xs text-ink-subtle">
                          Ref {payment.reference}
                        </p>
                      ) : null}
                      {payment.recordedBy ? (
                        <p className="text-xs text-ink-subtle">
                          Recorded by {payment.recordedBy.name}
                        </p>
                      ) : null}
                    </div>

                    {canRecord ? (
                      <form action={deletePayment} className="shrink-0">
                        <input type="hidden" name="id" value={payment.id} />
                        <button
                          type="submit"
                          aria-label="Remove payment"
                          title="Remove payment"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:bg-danger/10 hover:text-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Internal notes" />
            <NotesPanel
              notes={invoice.notes_}
              entityType="invoice"
              entityId={invoice.id}
              canWrite={writable}
              placeholder="Chasing notes, payment arrangements…"
              emptyDescription="These stay internal — the client never sees them."
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "warning" | "danger";
}) {
  return (
    <div className="px-5 py-3.5">
      <p className="text-xs text-ink-muted">{label}</p>
      <p
        className={`tabular mt-0.5 text-lg font-semibold ${
          tone === "success"
            ? "text-success"
            : tone === "warning"
              ? "text-warning"
              : tone === "danger"
                ? "text-danger"
                : "text-ink"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { PaymentEditForm } from "./payment-edit-form";
import { deletePayment } from "@/app/(app)/invoices/actions";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { requirePermission, safeNextPath } from "@/lib/auth";
import { asStatus, PAYMENT_METHODS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { centsToInput, currencySymbol, formatMoney } from "@/lib/money";
import { isPaymentProvider, PAYMENT_PROVIDER_META } from "@/lib/payments/catalog";
import { formatIn } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "Edit payment" };

/**
 * Correcting or deleting one payment. Opened from a client's Payments tab,
 * an invoice, or the payments list, and goes back to whichever it came from.
 */
export default async function EditPaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ back?: string }>;
}) {
  const { org } = await requirePermission("payments:record");
  const zone = await viewerTimeZone();
  const { id } = await params;
  const { back: rawBack } = await searchParams;

  const payment = await prisma.payment.findFirst({
    where: { id, organizationId: org.id },
    include: {
      invoice: { select: { id: true, number: true } },
      client: { select: { id: true, displayName: true } },
      recordedBy: { select: { name: true } },
    },
  });
  if (!payment) notFound();

  const back = safeNextPath(rawBack, `/invoices/${payment.invoice.id}`);
  const backLabel =
    back.startsWith("/clients/") && payment.client
      ? payment.client.displayName
      : back.startsWith("/payments")
        ? "Payments"
        : `Invoice ${payment.invoice.number}`;

  const processor = payment.provider
    ? isPaymentProvider(payment.provider)
      ? PAYMENT_PROVIDER_META[payment.provider].label
      : "the payment processor"
    : null;

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={back}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          {backLabel}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Edit payment
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {money(payment.amountCents)} on{" "}
          <Link
            href={`/invoices/${payment.invoice.id}`}
            className="font-medium text-ink transition-colors hover:text-brand"
          >
            invoice {payment.invoice.number}
          </Link>
          {payment.client ? (
            <>
              {" "}
              from{" "}
              <Link
                href={`/clients/${payment.client.id}`}
                className="font-medium text-ink transition-colors hover:text-brand"
              >
                {payment.client.displayName}
              </Link>
            </>
          ) : null}
          {payment.recordedBy ? ` · recorded by ${payment.recordedBy.name}` : null}
          {payment.editedAt
            ? ` · last changed ${formatIn(payment.editedAt, "MMM d, yyyy", zone)}`
            : null}
        </p>
      </div>

      <PaymentEditForm
        back={back}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        processor={processor}
        values={{
          id: payment.id,
          amount: centsToInput(payment.amountCents),
          method: asStatus(PAYMENT_METHODS, payment.method, "OTHER"),
          receivedAt: formatIn(payment.receivedAt, "yyyy-MM-dd", zone),
          reference: payment.reference ?? "",
          notes: payment.notes ?? "",
        }}
      />

      {/* Under the form rather than beside Save, so it is never the button
          somebody reaches for when they meant to keep their changes. */}
      <form
        action={deletePayment}
        className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line px-4 py-3"
      >
        <input type="hidden" name="id" value={payment.id} />
        <input type="hidden" name="back" value={back} />
        <p className="max-w-xl text-xs text-ink-muted">
          {processor
            ? `Deleting it here does not refund it. While ${processor} still shows it as paid, the next check will record it again — make refunds in ${processor}.`
            : `Deleting takes this ${money(payment.amountCents)} off invoice ${payment.invoice.number}, and its balance goes back up by the same.`}
        </p>
        <ConfirmButton variant="ghost" size="sm" confirmLabel="Delete for good?">
          Delete payment
        </ConfirmButton>
      </form>
    </div>
  );
}

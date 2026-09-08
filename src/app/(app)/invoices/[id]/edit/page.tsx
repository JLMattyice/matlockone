import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowLeft } from "lucide-react";

import { InvoiceForm } from "../../invoice-form";
import { getInvoice, invoiceClientOptions } from "../../queries";
import { priceBook } from "../../../estimates/queries";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";
import { requirePermission } from "@/lib/auth";
import { asStatus, DISCOUNT_TYPES, type DiscountType } from "@/lib/constants";
import { lineToDraft } from "@/lib/line-draft";
import { centsToInput, currencySymbol, formatMoney } from "@/lib/money";

export const metadata: Metadata = { title: "Edit invoice" };

export default async function EditInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { org } = await requirePermission("invoices:write");
  const { id } = await params;

  const [invoice, clients, book] = await Promise.all([
    getInvoice(org.id, id),
    invoiceClientOptions(org.id),
    priceBook(org.id),
  ]);

  // The action refuses these as well; stating it here saves the user retyping
  // a document that was never going to save.
  const blocked =
    invoice.status === "CANCELLED"
      ? "This invoice has been cancelled."
      : invoice.amountPaidCents > 0
        ? `${formatMoney(invoice.amountPaidCents, org.currency, org.locale)} has already been paid against this invoice.`
        : null;

  if (blocked) {
    return (
      <div className="mx-auto max-w-lg pt-10">
        <Card>
          <EmptyState
            title="This invoice can no longer be edited"
            description={`${blocked} Changing the amount now would rewrite what the client agreed to owe. Remove the payments first, or raise a separate invoice.`}
            action={
              <Link
                href={`/invoices/${invoice.id}`}
                className={buttonClasses("primary", "md")}
              >
                Back to invoice
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const discountType = asStatus(
    DISCOUNT_TYPES,
    invoice.discountType,
    "NONE",
  ) as DiscountType;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link
          href={`/invoices/${invoice.id}`}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          {invoice.number}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Edit invoice
        </h1>
      </div>

      <InvoiceForm
        clients={clients}
        priceBook={book}
        currency={org.currency}
        locale={org.locale}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        values={{
          id: invoice.id,
          clientId: invoice.clientId,
          addressId: invoice.addressId ?? "",
          jobId: invoice.jobId ?? "",
          title: invoice.title ?? "",
          issueDate: format(invoice.issueDate, "yyyy-MM-dd"),
          dueDate: invoice.dueDate ? format(invoice.dueDate, "yyyy-MM-dd") : "",
          paymentTermsDays: invoice.paymentTermsDays,
          notes: invoice.notes ?? "",
          terms: invoice.terms ?? "",
          discountType,
          discountValue:
            discountType === "PERCENT"
              ? (invoice.discountValue / 100).toString()
              : discountType === "FIXED"
                ? centsToInput(invoice.discountValue)
                : "",
          taxRate: (invoice.taxRateBp / 100).toString(),
          lines: invoice.lineItems.map(lineToDraft),
        }}
      />
    </div>
  );
}

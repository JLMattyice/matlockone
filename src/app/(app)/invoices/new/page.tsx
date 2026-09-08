import type { Metadata } from "next";
import Link from "next/link";
import { addDays, format } from "date-fns";
import { ArrowLeft } from "lucide-react";

import { InvoiceForm } from "../invoice-form";
import { invoiceClientOptions } from "../queries";
import { priceBook } from "../../estimates/queries";
import { requirePermission } from "@/lib/auth";
import { blankLine } from "@/lib/line-draft";
import { currencySymbol } from "@/lib/money";

export const metadata: Metadata = { title: "New invoice" };

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) {
  const { org } = await requirePermission("invoices:write");
  const params = await searchParams;

  const [clients, book] = await Promise.all([
    invoiceClientOptions(org.id),
    priceBook(org.id),
  ]);

  const client = params.clientId
    ? clients.find((c) => c.id === params.clientId)
    : undefined;

  const today = new Date();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link
          href="/invoices"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Invoices
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          New invoice
        </h1>
      </div>

      <InvoiceForm
        clients={clients}
        priceBook={book}
        currency={org.currency}
        locale={org.locale}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        values={{
          clientId: client?.id ?? "",
          addressId: client?.addresses.find((a) => a.isPrimary)?.id ?? "",
          jobId: "",
          title: "",
          issueDate: format(today, "yyyy-MM-dd"),
          dueDate: format(
            addDays(today, org.defaultPaymentTermsDays),
            "yyyy-MM-dd",
          ),
          paymentTermsDays: org.defaultPaymentTermsDays,
          notes: "",
          terms: org.invoiceFooter ?? "",
          discountType: "NONE",
          discountValue: "",
          taxRate: (org.defaultTaxRateBp / 100).toString(),
          lines: [blankLine()],
        }}
      />
    </div>
  );
}

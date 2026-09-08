import type { Metadata } from "next";
import Link from "next/link";
import { addDays, format } from "date-fns";
import { ArrowLeft } from "lucide-react";

import { EstimateForm } from "../estimate-form";
import { estimateClientOptions, priceBook } from "../queries";
import { requirePermission } from "@/lib/auth";
import { blankLine } from "@/lib/line-draft";
import { currencySymbol } from "@/lib/money";

export const metadata: Metadata = { title: "New estimate" };

export default async function NewEstimatePage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) {
  const { org } = await requirePermission("estimates:write");
  const params = await searchParams;

  const [clients, book] = await Promise.all([
    estimateClientOptions(org.id),
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
          href="/estimates"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Estimates
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          New estimate
        </h1>
      </div>

      <EstimateForm
        clients={clients}
        priceBook={book}
        currency={org.currency}
        locale={org.locale}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        values={{
          clientId: client?.id ?? "",
          addressId: client?.addresses.find((a) => a.isPrimary)?.id ?? "",
          title: "",
          issueDate: format(today, "yyyy-MM-dd"),
          expiresAt: format(
            addDays(today, org.defaultEstimateValidDays),
            "yyyy-MM-dd",
          ),
          notes: "",
          terms: org.estimateFooter ?? "",
          discountType: "NONE",
          discountValue: "",
          taxRate: (org.defaultTaxRateBp / 100).toString(),
          lines: [blankLine()],
        }}
      />
    </div>
  );
}

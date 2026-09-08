import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowLeft } from "lucide-react";

import { EstimateForm } from "../../estimate-form";
import { estimateClientOptions, getEstimate, priceBook } from "../../queries";
import { Card } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/page-header";
import { requirePermission } from "@/lib/auth";
import { asStatus, DISCOUNT_TYPES, type DiscountType } from "@/lib/constants";
import { effectiveEstimateStatus } from "@/lib/documents";
import { lineToDraft } from "@/lib/line-draft";
import { centsToInput, currencySymbol } from "@/lib/money";

export const metadata: Metadata = { title: "Edit estimate" };

export default async function EditEstimatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { org } = await requirePermission("estimates:write");
  const { id } = await params;

  const [estimate, clients, book] = await Promise.all([
    getEstimate(org.id, id),
    estimateClientOptions(org.id),
    priceBook(org.id),
  ]);

  const status = effectiveEstimateStatus(estimate);

  // The server action refuses these too; this is the same rule stated up front
  // instead of after the user has retyped the whole document.
  if (status === "ACCEPTED" || status === "DECLINED") {
    return (
      <div className="mx-auto max-w-lg pt-10">
        <Card>
          <EmptyState
            title={`This estimate has been ${status.toLowerCase()}`}
            description="It is a record of what the client responded to, so it can no longer be edited. Duplicate it to build a revised version."
            action={
              <Link
                href={`/estimates/${estimate.id}`}
                className={buttonClasses("primary", "md")}
              >
                Back to estimate
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const discountType = asStatus(
    DISCOUNT_TYPES,
    estimate.discountType,
    "NONE",
  ) as DiscountType;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link
          href={`/estimates/${estimate.id}`}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          {estimate.number}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Edit estimate
        </h1>
      </div>

      <EstimateForm
        clients={clients}
        priceBook={book}
        currency={org.currency}
        locale={org.locale}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        values={{
          id: estimate.id,
          clientId: estimate.clientId,
          addressId: estimate.addressId ?? "",
          title: estimate.title ?? "",
          issueDate: format(estimate.issueDate, "yyyy-MM-dd"),
          expiresAt: estimate.expiresAt
            ? format(estimate.expiresAt, "yyyy-MM-dd")
            : "",
          notes: estimate.notes ?? "",
          terms: estimate.terms ?? "",
          discountType,
          discountValue:
            discountType === "PERCENT"
              ? (estimate.discountValue / 100).toString()
              : discountType === "FIXED"
                ? centsToInput(estimate.discountValue)
                : "",
          taxRate: (estimate.taxRateBp / 100).toString(),
          lines: estimate.lineItems.map(lineToDraft),
        }}
      />
    </div>
  );
}

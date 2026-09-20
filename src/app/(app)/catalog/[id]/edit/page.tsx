import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { deleteCatalogItem } from "../../actions";
import { CatalogForm } from "../../catalog-form";
import { getCatalogItem, unitsInUse } from "../../queries";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  LINE_ITEM_KINDS,
  type LineItemKind,
} from "@/lib/constants";
import { centsToInput, currencySymbol } from "@/lib/money";

export const metadata: Metadata = { title: "Edit item" };

export default async function EditCatalogItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { org } = await requirePermission("catalog:write");
  const { id } = await params;

  const [item, units] = await Promise.all([
    getCatalogItem(org.id, id),
    unitsInUse(org.id),
  ]);
  if (!item) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/catalog"
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Products &amp; services
        </Link>
      </div>

      <CatalogForm
        units={units}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        values={{
          id: item.id,
          name: item.name,
          kind: asStatus(LINE_ITEM_KINDS, item.kind, "OTHER") as LineItemKind,
          description: item.description ?? "",
          unit: item.unit,
          price: centsToInput(item.unitPriceCents),
          taxable: item.taxable,
          isActive: item.isActive,
        }}
      />

      {/* Deleting is offered under the form rather than beside Save, because
          archiving is the answer almost every time — and nothing here can
          reach a document, which copied this item's values when it was used. */}
      <form
        action={deleteCatalogItem}
        className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line px-4 py-3"
      >
        <input type="hidden" name="id" value={item.id} />
        <p className="text-xs text-ink-muted">
          Estimates and invoices keep their own copy of the wording and price,
          so deleting this changes nothing that was already sent.
        </p>
        <ConfirmButton variant="ghost" size="sm" confirmLabel="Delete for good?">
          Delete
        </ConfirmButton>
      </form>
    </div>
  );
}

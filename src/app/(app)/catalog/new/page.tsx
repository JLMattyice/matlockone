import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { CatalogForm } from "../catalog-form";
import { unitsInUse } from "../queries";
import { requirePermission } from "@/lib/auth";
import { currencySymbol } from "@/lib/money";

export const metadata: Metadata = { title: "New item" };

export default async function NewCatalogItemPage() {
  const { org } = await requirePermission("catalog:write");
  const units = await unitsInUse(org.id);

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
          name: "",
          kind: "SERVICE",
          description: "",
          unit: "",
          price: "",
          taxable: true,
          isActive: true,
        }}
      />
    </div>
  );
}

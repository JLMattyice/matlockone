import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { CatalogImport } from "./import-form";
import { catalogNames } from "./queries";
import { requirePermission } from "@/lib/auth";

export const metadata: Metadata = { title: "Import products & services" };

export default async function ImportCatalogPage() {
  const { org } = await requirePermission("catalog:write");
  const names = await catalogNames(org.id);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href="/catalog"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Products &amp; services
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Import products &amp; services
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Bring in a price list you already keep — from Excel, Google Sheets,
          QuickBooks or another app — as a CSV file. Every estimate and invoice
          can then add an item in a click. You will see exactly what comes in
          before anything is saved.
        </p>
      </div>

      <CatalogImport onFileNames={names} currency={org.currency} locale={org.locale} />
    </div>
  );
}

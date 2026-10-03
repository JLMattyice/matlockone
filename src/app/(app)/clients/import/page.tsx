import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { ClientImport } from "./import-form";
import { onFileKeys } from "./queries";
import { requirePermission } from "@/lib/auth";

export const metadata: Metadata = { title: "Import clients" };

export default async function ImportClientsPage() {
  const { org } = await requirePermission("clients:write");
  const keys = await onFileKeys(org.id);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href="/clients"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          {org.labelClientPlural}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Import {org.labelClientPlural.toLowerCase()}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Bring in the list you already keep — from Excel, Google Sheets,
          QuickBooks or another app — as a CSV file. You will see exactly what
          comes in before anything is saved.
        </p>
      </div>

      <ClientImport
        singular={org.labelClientSingular}
        plural={org.labelClientPlural}
        onFileKeys={keys}
      />
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { ClientForm } from "../client-form";
import { emptyAddress } from "@/lib/address-draft";
import { requirePermission } from "@/lib/auth";

export const metadata: Metadata = { title: "New client" };

export default async function NewClientPage() {
  const { org } = await requirePermission("clients:write");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/clients"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          {org.labelClientPlural}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          New {org.labelClientSingular.toLowerCase()}
        </h1>
      </div>

      <ClientForm
        clientLabel={org.labelClientSingular}
        values={{
          type: "PERSON",
          firstName: "",
          lastName: "",
          businessName: "",
          email: "",
          phone: "",
          mobilePhone: "",
          website: "",
          status: "ACTIVE",
          source: "",
          taxExempt: false,
          addresses: [emptyAddress(true)],
        }}
      />
    </div>
  );
}

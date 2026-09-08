import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { ClientForm } from "../../client-form";
import { getClient } from "../../queries";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  CLIENT_STATUSES,
  CLIENT_TYPES,
  type ClientStatus,
  type ClientType,
} from "@/lib/constants";

export const metadata: Metadata = { title: "Edit client" };

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { org } = await requirePermission("clients:write");
  const { id } = await params;
  const client = await getClient(org.id, id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={`/clients/${client.id}`}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          {client.displayName}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Edit {org.labelClientSingular.toLowerCase()}
        </h1>
      </div>

      <ClientForm
        clientLabel={org.labelClientSingular}
        values={{
          id: client.id,
          type: asStatus(CLIENT_TYPES, client.type, "PERSON") as ClientType,
          firstName: client.firstName ?? "",
          lastName: client.lastName ?? "",
          businessName: client.businessName ?? "",
          email: client.email ?? "",
          phone: client.phone ?? "",
          mobilePhone: client.mobilePhone ?? "",
          website: client.website ?? "",
          status: asStatus(
            CLIENT_STATUSES,
            client.status,
            "ACTIVE",
          ) as ClientStatus,
          source: client.source ?? "",
          taxExempt: client.taxExempt,
          addresses: client.addresses.map((address) => ({
            key: address.id,
            id: address.id,
            label: address.label ?? "",
            line1: address.line1,
            line2: address.line2 ?? "",
            city: address.city ?? "",
            state: address.state ?? "",
            postalCode: address.postalCode ?? "",
            isPrimary: address.isPrimary,
            isBilling: address.isBilling,
            notes: address.notes ?? "",
          })),
        }}
      />
    </div>
  );
}

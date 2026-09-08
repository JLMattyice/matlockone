import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { LeadForm } from "../../lead-form";
import { assignableUsers, getLead } from "../../queries";
import { requirePermission } from "@/lib/auth";
import { asStatus, LEAD_STATUSES, type LeadStatus } from "@/lib/constants";
import { centsToInput, currencySymbol } from "@/lib/money";

export const metadata: Metadata = { title: "Edit lead" };

export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { org } = await requirePermission("leads:write");
  const { id } = await params;

  const [lead, team] = await Promise.all([
    getLead(org.id, id),
    assignableUsers(org.id),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={`/leads/${lead.id}`}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          {lead.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Edit lead</h1>
      </div>

      <LeadForm
        team={team}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        values={{
          id: lead.id,
          name: lead.name,
          businessName: lead.businessName ?? "",
          email: lead.email ?? "",
          phone: lead.phone ?? "",
          source: lead.source ?? "",
          status: asStatus(LEAD_STATUSES, lead.status, "NEW") as LeadStatus,
          estimatedValue: centsToInput(lead.estimatedValueCents),
          assignedToId: lead.assignedToId ?? "",
          lostReason: lead.lostReason ?? "",
        }}
      />
    </div>
  );
}

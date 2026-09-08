import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { LeadForm } from "../lead-form";
import { assignableUsers } from "../queries";
import { requirePermission } from "@/lib/auth";
import { currencySymbol } from "@/lib/money";

export const metadata: Metadata = { title: "New lead" };

export default async function NewLeadPage() {
  const { user, org } = await requirePermission("leads:write");
  const team = await assignableUsers(org.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/leads"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Leads
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">New lead</h1>
      </div>

      <LeadForm
        team={team}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        values={{
          name: "",
          businessName: "",
          email: "",
          phone: "",
          source: "",
          status: "NEW",
          estimatedValue: "",
          // Whoever takes the call is the obvious default owner.
          assignedToId: user.id,
          lostReason: "",
        }}
      />
    </div>
  );
}

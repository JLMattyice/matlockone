import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { MemberForm } from "../member-form";
import { requirePermission } from "@/lib/auth";
import { currencySymbol } from "@/lib/money";
import { assignableRoles } from "@/lib/permissions";

export const metadata: Metadata = { title: "Add team member" };

export default async function NewTeamMemberPage() {
  const { user, org } = await requirePermission("employees:write");
  const roles = assignableRoles(user);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/team"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Team
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Add team member
        </h1>
      </div>

      <MemberForm
        assignableRoles={roles}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        values={{
          name: "",
          email: "",
          phone: "",
          position: "",
          role: roles.includes("EMPLOYEE") ? "EMPLOYEE" : roles[0],
          hourlyRate: "",
        }}
      />
    </div>
  );
}

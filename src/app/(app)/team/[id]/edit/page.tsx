import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { MemberForm } from "../../member-form";
import { getTeamMember } from "../../queries";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";
import { requirePermission } from "@/lib/auth";
import { asStatus, ROLES, type Role } from "@/lib/constants";
import { centsToInput, currencySymbol } from "@/lib/money";
import { assignableRoles, canManageRole } from "@/lib/permissions";

export const metadata: Metadata = { title: "Edit team member" };

export default async function EditTeamMemberPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, org } = await requirePermission("employees:write");
  const { id } = await params;
  const member = await getTeamMember(org.id, id);

  const role = asStatus(ROLES, member.role, "EMPLOYEE") as Role;

  if (!canManageRole(user, role)) {
    return (
      <div className="mx-auto max-w-lg pt-10">
        <Card>
          <EmptyState
            title="You cannot edit this person"
            description="They hold a role at or above your own. Ask an owner to make the change."
            action={
              <Link href="/team" className={buttonClasses("primary", "md")}>
                Back to team
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const isSelf = member.id === user.id;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={`/team/${member.id}`}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          {member.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Edit team member
        </h1>
      </div>

      <MemberForm
        assignableRoles={assignableRoles(user)}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        lockRole={isSelf}
        lockReason="You cannot change your own role — ask another owner or administrator."
        values={{
          id: member.id,
          name: member.name,
          email: member.email,
          phone: member.phone ?? "",
          position: member.position ?? "",
          role,
          hourlyRate: centsToInput(member.hourlyRateCents),
        }}
      />
    </div>
  );
}

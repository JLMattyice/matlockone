import type { Metadata } from "next";

import { GroupForm } from "../../group-form";
import { getGroup } from "../../queries";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Edit group" };

export default async function EditGroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { org } = await requirePermission("employees:write");
  const { id } = await params;

  const group = await getGroup(org.id, id);
  const memberIds = group.members.map((row) => row.user.id);

  // Active people, plus anyone already in the group. A member who was
  // deactivated after joining must stay visible, or saving the form would
  // quietly drop them.
  const people = await prisma.user.findMany({
    where: {
      organizationId: org.id,
      OR: [{ isActive: true }, { id: { in: memberIds } }],
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, position: true, isActive: true },
  });

  return (
    <div className="mx-auto max-w-3xl">
      <GroupForm
        values={{
          id: group.id,
          name: group.name,
          description: group.description ?? "",
          leadId: group.leadId ?? "",
          memberIds,
        }}
        people={people}
      />
    </div>
  );
}

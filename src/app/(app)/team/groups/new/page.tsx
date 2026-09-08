import type { Metadata } from "next";

import { GroupForm } from "../group-form";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "New group" };

export default async function NewGroupPage() {
  const { org } = await requirePermission("employees:write");

  // Only active people can be put into a new group; a deactivated account
  // already appears nowhere else you would assign work.
  const people = await prisma.user.findMany({
    where: { organizationId: org.id, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, position: true, isActive: true },
  });

  return (
    <div className="mx-auto max-w-3xl">
      <GroupForm
        values={{ name: "", description: "", leadId: "", memberIds: [] }}
        people={people}
      />
    </div>
  );
}

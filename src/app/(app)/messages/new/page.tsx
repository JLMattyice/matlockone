import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";

import { NewConversationForm } from "@/components/messages/new-conversation-form";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "New message" };

export default async function NewConversationPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string | string[] }>;
}) {
  const { user, org } = await requirePermission("messages:use");
  const params = await searchParams;

  const people = await prisma.user.findMany({
    where: { organizationId: org.id, isActive: true, id: { not: user.id } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, avatarUrl: true, position: true },
  });

  if (people.length === 0) {
    return (
      <Card className="flex h-full items-center justify-center">
        <EmptyState
          icon={<Users className="h-5 w-5" strokeWidth={1.75} />}
          title="Nobody else is on the team yet"
          description="Once somebody else has an account, you can message them here."
          action={
            can(user, "employees:write") ? (
              <Link href="/team/new" className={buttonClasses("outline", "md")}>
                Add a team member
              </Link>
            ) : undefined
          }
        />
      </Card>
    );
  }

  // Only ids that are really on the list, so a stale link cannot pick a
  // person the form has no row for.
  const wanted = [params.to ?? []].flat();
  const preselected = people.filter((person) => wanted.includes(person.id)).map((p) => p.id);

  return <NewConversationForm people={people} preselected={preselected} />;
}

import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Users } from "lucide-react";

import { listGroups } from "./queries";
import { TeamTabs } from "../tabs";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Groups" };

export default async function GroupsPage() {
  const { user, org } = await requirePermission("employees:read");

  const [groups, memberCount] = await Promise.all([
    listGroups(org.id),
    prisma.user.count({ where: { organizationId: org.id } }),
  ]);

  const writable = can(user, "employees:write");
  const active = groups.filter((group) => group.isActive);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description={`${active.length} active ${active.length === 1 ? "group" : "groups"}`}
        actions={
          writable ? (
            <Link
              href="/team/groups/new"
              className={buttonClasses("primary", "md")}
            >
              <Plus className="h-4 w-4" strokeWidth={2} />
              New group
            </Link>
          ) : null
        }
      />

      <TeamTabs active="groups" members={memberCount} groups={groups.length} />

      <Card className="overflow-hidden">
        {groups.length === 0 ? (
          <EmptyState
            icon={<Users className="h-5 w-5" strokeWidth={1.75} />}
            title="No groups yet"
            description="Group people who work together — by shift, territory or department — then schedule and report on them as one."
            action={
              writable ? (
                <Link
                  href="/team/groups/new"
                  className={buttonClasses("primary", "md")}
                >
                  <Plus className="h-4 w-4" strokeWidth={2} />
                  New group
                </Link>
              ) : null
            }
          />
        ) : (
          <Table>
            <THead>
              <Th>Group</Th>
              <Th className="hidden md:table-cell">Lead</Th>
              <Th align="right">People</Th>
              <Th align="right" className="hidden sm:table-cell">
                Open work
              </Th>
              <Th align="right" className="hidden lg:table-cell">
                This week
              </Th>
              <Th />
            </THead>

            <TBody>
              {groups.map((group) => (
                <Tr
                  key={group.id}
                  className={group.isActive ? undefined : "opacity-60"}
                >
                  <Td>
                    <Link
                      href={`/team/groups/${group.id}`}
                      className="group block"
                    >
                      <span className="block truncate font-medium text-ink group-hover:text-brand">
                        {group.name}
                      </span>
                      {group.description ? (
                        <span className="block truncate text-xs text-ink-subtle">
                          {group.description}
                        </span>
                      ) : null}
                    </Link>
                  </Td>

                  <Td className="hidden md:table-cell">
                    {group.lead ? (
                      <span className="flex items-center gap-2">
                        <Avatar name={group.lead.name} size="sm" />
                        <span className="truncate text-ink-muted">
                          {group.lead.name}
                        </span>
                      </span>
                    ) : (
                      <span className="text-ink-subtle">—</span>
                    )}
                  </Td>

                  <Td align="right" className="tabular">
                    {group._count.members || "—"}
                  </Td>

                  <Td align="right" className="tabular hidden sm:table-cell">
                    {group.openJobs || "—"}
                  </Td>

                  <Td
                    align="right"
                    className="tabular hidden text-ink-muted lg:table-cell"
                  >
                    {group.jobsThisWeek || "—"}
                  </Td>

                  <Td>
                    {group.isActive ? null : <Badge>Retired</Badge>}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

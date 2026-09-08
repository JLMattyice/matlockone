import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { HardHat, Plus } from "lucide-react";

import { listTeam } from "./queries";
import { TeamTabs } from "./tabs";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import { asStatus, ROLE_META, ROLES, type Role } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { can, permissionsFor } from "@/lib/permissions";
import { formatPhone } from "@/lib/utils";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const { user, org } = await requirePermission("employees:read");

  const [members, groupCount] = await Promise.all([
    listTeam(org.id),
    prisma.group.count({ where: { organizationId: org.id } }),
  ]);

  const writable = can(user, "employees:write");
  const active = members.filter((m) => m.isActive);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description={`${active.length} active · ${members.length - active.length} deactivated`}
        actions={
          writable ? (
            <Link href="/team/new" className={buttonClasses("primary", "md")}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              Add team member
            </Link>
          ) : null
        }
      />

      <TeamTabs active="members" members={members.length} groups={groupCount} />

      <Card className="overflow-hidden">
        {members.length === 0 ? (
          <EmptyState
            icon={<HardHat className="h-5 w-5" strokeWidth={1.75} />}
            title="No team members yet"
          />
        ) : (
          <Table>
            <THead>
              <Th>Name</Th>
              <Th className="hidden md:table-cell">Contact</Th>
              <Th align="right" className="hidden sm:table-cell">
                Open work
              </Th>
              <Th align="right" className="hidden lg:table-cell">
                This week
              </Th>
              <Th align="right" className="hidden xl:table-cell">
                Rate
              </Th>
              <Th className="hidden lg:table-cell">Last seen</Th>
              <Th>Role</Th>
            </THead>

            <TBody>
              {members.map((member) => {
                const role = asStatus(ROLES, member.role, "EMPLOYEE") as Role;
                const meta = ROLE_META[role];

                return (
                  <Tr
                    key={member.id}
                    className={member.isActive ? undefined : "opacity-60"}
                  >
                    <Td>
                      <Link
                        href={`/team/${member.id}`}
                        className="group flex items-center gap-3"
                      >
                        <Avatar name={member.name} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink group-hover:text-brand">
                            {member.name}
                          </span>
                          <span className="block truncate text-xs text-ink-subtle">
                            {member.position ?? "—"}
                          </span>
                        </span>
                      </Link>
                    </Td>

                    <Td className="hidden md:table-cell">
                      <span className="block truncate text-ink-muted">
                        {member.email}
                      </span>
                      <span className="tabular block text-xs text-ink-subtle">
                        {formatPhone(member.phone)}
                      </span>
                    </Td>

                    <Td align="right" className="tabular hidden sm:table-cell">
                      {member.openJobs || "—"}
                    </Td>

                    <Td
                      align="right"
                      className="tabular hidden text-ink-muted lg:table-cell"
                    >
                      {member.jobsThisWeek || "—"}
                    </Td>

                    <Td
                      align="right"
                      className="tabular hidden whitespace-nowrap text-ink-muted xl:table-cell"
                    >
                      {member.hourlyRateCents
                        ? `${formatMoney(member.hourlyRateCents, org.currency, org.locale)}/hr`
                        : "—"}
                    </Td>

                    <Td className="hidden whitespace-nowrap text-ink-muted lg:table-cell">
                      {member.lastLoginAt
                        ? `${formatDistanceToNow(member.lastLoginAt)} ago`
                        : "Never"}
                    </Td>

                    <Td>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        {!member.isActive ? <Badge>Deactivated</Badge> : null}
                      </span>
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="What each role can do"
          description="Checked in the navigation, and again on every page and action."
        />
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2">
                <th className="px-5 py-2.5 text-left text-xs font-semibold tracking-wide text-ink-muted uppercase">
                  Role
                </th>
                <th className="px-5 py-2.5 text-left text-xs font-semibold tracking-wide text-ink-muted uppercase">
                  Access
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ROLES.map((role) => (
                <tr key={role}>
                  <td className="px-5 py-3 align-top whitespace-nowrap">
                    <Badge tone={ROLE_META[role].tone}>
                      {ROLE_META[role].label}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-ink-muted">
                    <p>{ROLE_META[role].description}</p>
                    <p className="mt-1 text-xs text-ink-subtle">
                      {permissionsFor(role).length} permissions
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

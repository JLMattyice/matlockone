import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowLeft, Pencil, Users } from "lucide-react";

import { deleteGroup, setGroupActive } from "../actions";
import { getGroup, groupWorkload } from "../queries";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { requirePermission } from "@/lib/auth";
import { asStatus, JOB_STATUS_META, JOB_STATUSES, ROLE_META, ROLES, type Role } from "@/lib/constants";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/utils";

export const metadata: Metadata = { title: "Group" };

export default async function GroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, org } = await requirePermission("employees:read");
  const { id } = await params;

  const group = await getGroup(org.id, id);
  const work = await groupWorkload(org.id, group.id);

  const writable = can(user, "employees:write");
  const members = group.members.map((row) => row.user);

  return (
    <div className="space-y-6">
      <Link
        href="/team/groups"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={2} />
        All groups
      </Link>

      <PageHeader
        title={group.name}
        description={group.description ?? undefined}
        actions={
          writable ? (
            <Link
              href={`/team/groups/${group.id}/edit`}
              className={buttonClasses("outline", "md")}
            >
              <Pencil className="h-4 w-4" strokeWidth={2} />
              Edit
            </Link>
          ) : null
        }
      />

      {group.isActive ? null : (
        <p className="rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-ink-muted">
          <span className="font-medium text-ink">Retired.</span> Past work still
          shows this group, but it is no longer offered when assigning.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Members"
              description={
                members.length === 1 ? "1 person" : `${members.length} people`
              }
            />

            {members.length === 0 ? (
              <EmptyState
                icon={<Users className="h-5 w-5" strokeWidth={1.75} />}
                title="Nobody in this group yet"
                action={
                  writable ? (
                    <Link
                      href={`/team/groups/${group.id}/edit`}
                      className={buttonClasses("outline", "md")}
                    >
                      Add people
                    </Link>
                  ) : null
                }
              />
            ) : (
              <CardBody className="grid gap-2 sm:grid-cols-2">
                {members.map((member) => {
                  const role = asStatus(ROLES, member.role, "EMPLOYEE") as Role;

                  return (
                    <Link
                      key={member.id}
                      href={`/team/${member.id}`}
                      className="group flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 transition-colors hover:border-line-strong"
                    >
                      <Avatar name={member.name} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink group-hover:text-brand">
                          {member.name}
                          {member.id === group.leadId ? (
                            <span className="ml-2 rounded-full bg-brand/12 px-2 py-0.5 text-[0.6875rem] font-medium text-brand">
                              Lead
                            </span>
                          ) : null}
                        </span>
                        <span className="block truncate text-xs text-ink-subtle">
                          {member.position ?? ROLE_META[role].label}
                          {member.phone ? ` · ${formatPhone(member.phone)}` : ""}
                        </span>
                      </span>
                      {member.isActive ? null : <Badge>Deactivated</Badge>}
                    </Link>
                  );
                })}
              </CardBody>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Open work"
              description="Jobs this group is answerable for."
            />

            {work.upcoming.length === 0 ? (
              <EmptyState title="Nothing open right now" />
            ) : (
              <CardBody className="space-y-2">
                {work.upcoming.map((job) => {
                  const status = asStatus(JOB_STATUSES, job.status, "SCHEDULED");

                  return (
                    <Link
                      key={job.id}
                      href={`/jobs/${job.id}`}
                      className="group flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 transition-colors hover:border-line-strong"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink group-hover:text-brand">
                          {job.title}
                        </span>
                        <span className="block truncate text-xs text-ink-subtle">
                          {job.number}
                          {job.client ? ` · ${job.client.displayName}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-ink-subtle">
                        {job.scheduledStart
                          ? format(job.scheduledStart, "d MMM")
                          : "Unscheduled"}
                      </span>
                      <Badge tone={JOB_STATUS_META[status].tone}>
                        {JOB_STATUS_META[status].label}
                      </Badge>
                    </Link>
                  );
                })}
              </CardBody>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="At a glance" />
            <CardBody className="space-y-3 text-sm">
              <Row label="Lead" value={group.lead?.name ?? "—"} />
              <Row label="People" value={String(members.length)} />
              <Row label="Scheduled this week" value={String(work.thisWeek)} />
              <Row label="Completed" value={String(work.completed)} />
              <Row
                label="Created"
                value={format(group.createdAt, "d MMM yyyy")}
              />
            </CardBody>

            {writable ? (
              <CardFooter className="flex-wrap">
                <form action={setGroupActive} className="mr-auto">
                  <input type="hidden" name="groupId" value={group.id} />
                  <input
                    type="hidden"
                    name="isActive"
                    value={group.isActive ? "false" : "true"}
                  />
                  <Button type="submit" variant="ghost" size="sm">
                    {group.isActive ? "Retire group" : "Reinstate"}
                  </Button>
                </form>

                <form action={deleteGroup}>
                  <input type="hidden" name="groupId" value={group.id} />
                  <ConfirmButton size="sm">Delete</ConfirmButton>
                </form>
              </CardFooter>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Find their work" />
            <CardBody className="space-y-2">
              <Link
                href={`/jobs?group=${group.id}`}
                className={buttonClasses("outline", "md") + " w-full justify-center"}
              >
                Jobs for this group
              </Link>
              <Link
                href={`/schedule?group=${group.id}`}
                className={buttonClasses("ghost", "md") + " w-full justify-center"}
              >
                On the schedule
              </Link>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-ink-muted">{label}</span>
      <span className="tabular font-medium text-ink">{value}</span>
    </div>
  );
}

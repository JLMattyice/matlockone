import type { Metadata } from "next";
import Link from "next/link";
import { format, isToday, isTomorrow, isYesterday } from "date-fns";
import { Briefcase, CalendarDays, Plus, Repeat } from "lucide-react";

import { activeCrew, jobStatusCounts, listJobs } from "./queries";
import { assignableGroups } from "../team/groups/queries";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  JOB_PRIORITY_META,
  JOB_PRIORITIES,
  JOB_STATUS_META,
  JOB_STATUSES,
} from "@/lib/constants";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Jobs" };

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    kind?: string;
    assignedTo?: string;
    group?: string;
    page?: string;
  }>;
}) {
  const ctx = await requirePermission("jobs:read");
  const { user, org } = ctx;
  const params = await searchParams;

  const [list, counts, crew, groups] = await Promise.all([
    listJobs({
      ctx,
      q: params.q,
      status: params.status,
      kind: params.kind,
      assignedTo: params.assignedTo,
      groupId: params.group,
      page: Number(params.page) || 1,
    }),
    jobStatusCounts(ctx),
    can(user, "jobs:assign") ? activeCrew(org.id) : Promise.resolve([]),
    assignableGroups(org.id),
  ]);

  const writable = can(user, "jobs:write");
  const isFiltered = Boolean(
    params.q || params.status || params.kind || params.assignedTo || params.group,
  );

  const active =
    (counts.get("SCHEDULED") ?? 0) +
    (counts.get("CONFIRMED") ?? 0) +
    (counts.get("IN_PROGRESS") ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={org.labelJobPlural}
        description={`${active} open · ${list.total} shown`}
        actions={
          <>
            <Link href="/schedule" className={buttonClasses("outline", "md")}>
              <CalendarDays className="h-4 w-4" strokeWidth={2} />
              Schedule
            </Link>
            {writable ? (
              <Link href="/jobs/new" className={buttonClasses("primary", "md")}>
                <Plus className="h-4 w-4" strokeWidth={2} />
                New {org.labelJobSingular.toLowerCase()}
              </Link>
            ) : null}
          </>
        }
      />

      <ListToolbar
        searchPlaceholder="Search number, title, client or address…"
        filters={[
          {
            name: "status",
            label: "statuses",
            options: JOB_STATUSES.map((status) => ({
              value: status,
              label: `${JOB_STATUS_META[status].label} (${counts.get(status) ?? 0})`,
            })),
          },
          {
            name: "kind",
            label: "types",
            options: [
              { value: "JOB", label: org.labelJobPlural },
              { value: "APPOINTMENT", label: "Appointments" },
            ],
          },
          ...(groups.length
            ? [
                {
                  name: "group",
                  label: "groups",
                  allLabel: "All groups",
                  options: groups.map((group) => ({
                    value: group.id,
                    label: group.name,
                  })),
                },
              ]
            : []),
          ...(crew.length
            ? [
                {
                  name: "assignedTo",
                  label: "people",
                  allLabel: "Anyone",
                  options: crew.map((member) => ({
                    value: member.id,
                    label: member.name,
                  })),
                },
              ]
            : []),
        ]}
      />

      <Card className="overflow-hidden">
        {list.rows.length === 0 ? (
          <EmptyState
            icon={<Briefcase className="h-5 w-5" strokeWidth={1.75} />}
            title={
              isFiltered
                ? "No matches"
                : `No ${org.labelJobPlural.toLowerCase()} yet`
            }
            description={
              isFiltered
                ? "Try a different search or clear the filters."
                : "Create a work order and put it on the calendar."
            }
            action={
              !isFiltered && writable ? (
                <Link href="/jobs/new" className={buttonClasses("primary", "md")}>
                  <Plus className="h-4 w-4" strokeWidth={2} />
                  New {org.labelJobSingular.toLowerCase()}
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <Th>Number</Th>
                <Th>Title</Th>
                <Th className="hidden md:table-cell">Client</Th>
                <Th className="hidden lg:table-cell">Scheduled</Th>
                <Th className="hidden xl:table-cell">Assigned</Th>
                <Th>Status</Th>
              </THead>

              <TBody>
                {list.rows.map((job) => {
                  const status = asStatus(JOB_STATUSES, job.status, "SCHEDULED");
                  const meta = JOB_STATUS_META[status];
                  const priority = asStatus(
                    JOB_PRIORITIES,
                    job.priority,
                    "NORMAL",
                  );

                  return (
                    <Tr key={job.id}>
                      <Td className="tabular font-medium whitespace-nowrap">
                        <Link
                          href={`/jobs/${job.id}`}
                          className="transition-colors hover:text-brand"
                        >
                          {job.number}
                        </Link>
                      </Td>

                      <Td>
                        <Link href={`/jobs/${job.id}`} className="group block">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-ink group-hover:text-brand">
                              {job.title}
                            </span>
                            {job.recurrenceRule ? (
                              <Repeat
                                className="h-3.5 w-3.5 shrink-0 text-ink-subtle"
                                strokeWidth={1.75}
                                aria-label="Repeats"
                              />
                            ) : null}
                          </span>
                          <span className="flex items-center gap-1.5 text-xs text-ink-subtle">
                            {job.kind === "APPOINTMENT" ? (
                              <span>Appointment</span>
                            ) : job.address ? (
                              <span className="truncate">
                                {[job.address.line1, job.address.city]
                                  .filter(Boolean)
                                  .join(", ")}
                              </span>
                            ) : null}
                            {priority !== "NORMAL" ? (
                              <Badge tone={JOB_PRIORITY_META[priority].tone}>
                                {JOB_PRIORITY_META[priority].label}
                              </Badge>
                            ) : null}
                          </span>
                        </Link>
                      </Td>

                      <Td className="hidden md:table-cell">
                        {job.client ? (
                          <Link
                            href={`/clients/${job.client.id}`}
                            className="block truncate text-ink-muted transition-colors hover:text-brand"
                          >
                            {job.client.displayName}
                          </Link>
                        ) : (
                          <span className="text-ink-subtle">—</span>
                        )}
                      </Td>

                      <Td className="tabular hidden whitespace-nowrap text-ink-muted lg:table-cell">
                        {job.scheduledStart ? (
                          <>
                            <span className="block">
                              {relativeDay(job.scheduledStart)}
                            </span>
                            <span className="block text-xs text-ink-subtle">
                              {job.allDay
                                ? "All day"
                                : format(job.scheduledStart, "h:mm a")}
                            </span>
                          </>
                        ) : (
                          <span className="text-warning">Unscheduled</span>
                        )}
                      </Td>

                      <Td className="hidden text-ink-muted xl:table-cell">
                        <span className="block truncate">
                          {job.assignments.map((a) => a.user.name).join(", ") ||
                            "Unassigned"}
                        </span>
                      </Td>

                      <Td>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>

            <Pagination
              page={list.page}
              pageCount={list.pageCount}
              total={list.total}
              pageSize={list.pageSize}
              pathname="/jobs"
              params={{
                q: params.q,
                status: params.status,
                kind: params.kind,
                assignedTo: params.assignedTo,
                group: params.group,
              }}
              itemLabel={org.labelJobPlural.toLowerCase()}
            />
          </>
        )}
      </Card>
    </div>
  );
}

function relativeDay(date: Date) {
  if (isToday(date)) return "Today";
  if (isTomorrow(date)) return "Tomorrow";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "MMM d, yyyy");
}

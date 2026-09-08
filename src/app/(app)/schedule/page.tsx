import type { Metadata } from "next";
import Link from "next/link";
import {
  addDays,
  addMonths,
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
} from "date-fns";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { ScheduleCalendar } from "./calendar";
import {
  CALENDAR_VIEWS,
  isCalendarView,
  type CalendarEvent,
  type CalendarView,
  type UnscheduledJob,
} from "./types";
import { activeCrew, scheduleEvents, unscheduledJobs } from "../jobs/queries";
import { assignableGroups } from "../team/groups/queries";
import { buttonClasses } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  JOB_STATUS_META,
  JOB_STATUSES,
  type JobStatus,
} from "@/lib/constants";
import { can } from "@/lib/permissions";
import { durationMinutes } from "@/lib/utils";

export const metadata: Metadata = { title: "Schedule" };

type SearchParams = Promise<{
  view?: string;
  date?: string;
  assignedTo?: string;
  group?: string;
  status?: string;
}>;

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const ctx = await requirePermission("schedule:read");
  const { user, org } = ctx;
  const params = await searchParams;

  const view: CalendarView = isCalendarView(params.view) ? params.view : "week";
  const anchor = parseAnchor(params.date);
  const { from, to } = rangeFor(view, anchor);

  const [jobs, waiting, crew, groups] = await Promise.all([
    scheduleEvents(ctx, from, to, {
      assignedTo: params.assignedTo,
      groupId: params.group,
      status: params.status,
    }),
    unscheduledJobs(ctx),
    can(user, "jobs:assign") ? activeCrew(org.id) : Promise.resolve([]),
    assignableGroups(org.id),
  ]);

  const events: CalendarEvent[] = jobs
    .filter((job) => job.scheduledStart)
    .map((job) => ({
      id: job.id,
      number: job.number,
      title: job.title,
      kind: job.kind,
      status: asStatus(JOB_STATUSES, job.status, "SCHEDULED") as JobStatus,
      startISO: job.scheduledStart!.toISOString(),
      endISO: (
        job.scheduledEnd ??
        new Date(job.scheduledStart!.getTime() + 60 * 60_000)
      ).toISOString(),
      allDay: job.allDay,
      durationMinutes: durationMinutes(
        job.scheduledStart,
        job.scheduledEnd,
        job.estimatedMinutes ?? 60,
      ),
      clientName: job.client?.displayName ?? null,
      location: job.address
        ? [job.address.line1, job.address.city].filter(Boolean).join(", ")
        : null,
      crew: job.assignments.map((a) => a.user.name),
    }));

  const unscheduled: UnscheduledJob[] = waiting.map((job) => ({
    id: job.id,
    number: job.number,
    title: job.title,
    status: asStatus(JOB_STATUSES, job.status, "SCHEDULED") as JobStatus,
    clientName: job.client?.displayName ?? null,
    durationMinutes: job.estimatedMinutes ?? 60,
    crew: job.assignments.map((a) => a.user.name),
  }));

  const href = (next: Partial<Record<string, string>>) => {
    const search = new URLSearchParams();
    const merged = {
      view: params.view,
      date: params.date,
      assignedTo: params.assignedTo,
      group: params.group,
      status: params.status,
      ...next,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value) search.set(key, value);
    }
    const qs = search.toString();
    return qs ? `/schedule?${qs}` : "/schedule";
  };

  const step = (direction: -1 | 1) => {
    const moved =
      view === "day"
        ? direction === 1
          ? addDays(anchor, 1)
          : subDays(anchor, 1)
        : view === "week"
          ? direction === 1
            ? addDays(anchor, 7)
            : subDays(anchor, 7)
          : direction === 1
            ? addMonths(anchor, 1)
            : subMonths(anchor, 1);
    return href({ date: format(moved, "yyyy-MM-dd") });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Schedule"
        description={rangeLabel(view, anchor)}
        actions={
          can(user, "jobs:write") ? (
            <Link href="/jobs/new" className={buttonClasses("primary", "md")}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              New {org.labelJobSingular.toLowerCase()}
            </Link>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Link
            href={step(-1)}
            aria-label="Previous"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
          </Link>
          <Link
            href={step(1)}
            aria-label="Next"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </Link>
          <Link
            href={href({ date: format(new Date(), "yyyy-MM-dd") })}
            className={buttonClasses("outline", "md", "ml-1")}
          >
            Today
          </Link>
        </div>

        <div className="flex rounded-lg border border-line p-0.5">
          {CALENDAR_VIEWS.map((option) => (
            <Link
              key={option}
              href={href({ view: option })}
              aria-current={view === option ? "page" : undefined}
              className={
                view === option
                  ? "rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink capitalize"
                  : "rounded-md px-3 py-1.5 text-sm text-ink-muted capitalize transition-colors hover:text-ink"
              }
            >
              {option}
            </Link>
          ))}
        </div>

        <ScheduleFilters
          crew={crew}
          groups={groups}
          group={params.group}
          assignedTo={params.assignedTo}
          status={params.status}
          hrefFor={href}
        />
      </div>

      <ScheduleCalendar
        view={view}
        anchorISO={anchor.toISOString()}
        events={events}
        unscheduled={unscheduled}
        canDrag={can(user, "schedule:write")}
        canCreate={can(user, "jobs:write")}
      />

      <p className="text-xs text-ink-subtle">
        {can(user, "schedule:write")
          ? "Drag a block to move it. Click an empty slot to book something new."
          : "Read-only — ask a manager to change the schedule."}
      </p>
    </div>
  );
}

/**
 * Filters are plain links rather than a client component: the schedule is fully
 * server-rendered apart from the drag interaction, and keeping these as links
 * means a filtered calendar is a shareable URL.
 */
function ScheduleFilters({
  crew,
  groups,
  group,
  assignedTo,
  status,
  hrefFor,
}: {
  crew: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  group?: string;
  assignedTo?: string;
  status?: string;
  hrefFor: (next: Partial<Record<string, string>>) => string;
}) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {crew.length > 0 || groups.length > 0 ? (
        <form action="/schedule" className="contents">
          {groups.length > 0 ? (
            <Select
              name="group"
              defaultValue={group ?? ""}
              aria-label="Filter by group"
              className="w-40"
            >
              <option value="">All groups</option>
              {groups.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          ) : null}

          {crew.length > 0 ? (
            <Select
              name="assignedTo"
              defaultValue={assignedTo ?? ""}
              aria-label="Filter by person"
              className="w-40"
              // Server-rendered form: submitting navigates with the new query.
            >
              <option value="">Everyone</option>
              {crew.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </Select>
          ) : null}

          {status ? <input type="hidden" name="status" value={status} /> : null}
          <button type="submit" className={buttonClasses("outline", "md")}>
            Apply
          </button>
        </form>
      ) : null}

      {(assignedTo || status || group) && (
        <Link href={hrefFor({ assignedTo: "", status: "", group: "" })} className={buttonClasses("ghost", "md")}>
          Clear
        </Link>
      )}
    </div>
  );
}

function parseAnchor(value: string | undefined) {
  if (!value) return new Date();
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function rangeFor(view: CalendarView, anchor: Date) {
  if (view === "day") {
    return { from: startOfDay(anchor), to: endOfDay(anchor) };
  }
  if (view === "week") {
    return { from: startOfWeek(anchor), to: endOfWeek(anchor) };
  }
  // Month view shows leading and trailing days from the neighbouring months,
  // so the query has to cover the whole visible grid, not just the month.
  return {
    from: startOfWeek(startOfMonth(anchor)),
    to: endOfWeek(endOfMonth(anchor)),
  };
}

function rangeLabel(view: CalendarView, anchor: Date) {
  if (view === "day") return format(anchor, "EEEE, MMMM d, yyyy");
  if (view === "month") return format(anchor, "MMMM yyyy");

  const start = startOfWeek(anchor);
  const end = endOfWeek(anchor);
  const sameMonth = start.getMonth() === end.getMonth();

  return sameMonth
    ? `${format(start, "MMMM d")} – ${format(end, "d, yyyy")}`
    : `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
}

import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";

import { ClockEntryRow, type ClockRow } from "./entry-row";
import { TeamTabs } from "../tabs";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { clockMinutes } from "@/lib/time-clock";
import { formatIn, parseDateTimeLocal, todayIn, toDateTimeLocal } from "@/lib/time-zone";
import { formatMinutes } from "@/lib/utils";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "Time clock" };

const DAY = 24 * 60 * 60 * 1000;

/** The Sunday-to-Saturday week holding `value`, as the schedule draws weeks. */
function weekOf(value: string | undefined, zone: string) {
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? value! : todayIn(zone);
  const [y, m, d] = anchor.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const sunday = new Date(noon.getTime() - noon.getUTCDay() * DAY);
  const date = (offset: number) => new Date(sunday.getTime() + offset * DAY).toISOString().slice(0, 10);
  return {
    first: date(0),
    last: date(6),
    start: parseDateTimeLocal(`${date(0)}T00:00`, zone)!,
    end: parseDateTimeLocal(`${date(7)}T00:00`, zone)!,
    previous: date(-7),
    next: date(7),
  };
}

/**
 * Team → Time clock: who is on the clock now, and each person's hours for a
 * week, from the clock on My Day. Whoever schedules the crews can fix an
 * entry somebody forgot to close.
 */
export default async function TimeClockPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { user, org } = await requirePermission("employees:read");
  const zone = await viewerTimeZone();
  const week = weekOf((await searchParams).week, zone);
  const now = new Date();

  const [entries, openNow, memberCount, groupCount] = await Promise.all([
    prisma.clockEntry.findMany({
      where: { organizationId: org.id, clockedInAt: { gte: week.start, lt: week.end } },
      orderBy: [{ clockedInAt: "desc" }],
      select: {
        id: true,
        clockedInAt: true,
        clockedOutAt: true,
        user: { select: { id: true, name: true } },
        editedBy: { select: { name: true } },
      },
    }),
    prisma.clockEntry.findMany({
      where: { organizationId: org.id, clockedOutAt: null },
      orderBy: { clockedInAt: "asc" },
      select: { id: true, clockedInAt: true, user: { select: { id: true, name: true } } },
    }),
    prisma.user.count({ where: { organizationId: org.id } }),
    prisma.group.count({ where: { organizationId: org.id } }),
  ]);

  // What each person is timing right now, beside their name.
  const timers = await prisma.timeEntry.findMany({
    where: { organizationId: org.id, endedAt: null, userId: { in: openNow.map((entry) => entry.user.id) } },
    select: { userId: true, job: { select: { id: true, number: true, title: true } } },
  });

  const totals = new Map<string, { id: string; name: string; minutes: number; days: Set<string> }>();
  for (const entry of entries) {
    const row = totals.get(entry.user.id) ?? {
      id: entry.user.id,
      name: entry.user.name,
      minutes: 0,
      days: new Set<string>(),
    };
    row.minutes += clockMinutes(entry, now);
    row.days.add(formatIn(entry.clockedInAt, "yyyy-MM-dd", zone));
    totals.set(entry.user.id, row);
  }
  const people = [...totals.values()].sort((a, b) => a.name.localeCompare(b.name));

  const rows: ClockRow[] = entries.map((entry) => ({
    id: entry.id,
    person: entry.user.name,
    day: formatIn(entry.clockedInAt, "EEE, MMM d", zone),
    inLabel: formatIn(entry.clockedInAt, "h:mm a", zone),
    outLabel: entry.clockedOutAt
      ? formatIn(
          entry.clockedOutAt,
          formatIn(entry.clockedOutAt, "yyyy-MM-dd", zone) === formatIn(entry.clockedInAt, "yyyy-MM-dd", zone)
            ? "h:mm a"
            : "EEE h:mm a",
          zone,
        )
      : null,
    hours: formatMinutes(clockMinutes(entry, now)),
    inValue: toDateTimeLocal(entry.clockedInAt, zone),
    outValue: toDateTimeLocal(entry.clockedOutAt, zone),
    editedBy: entry.editedBy?.name ?? null,
  }));

  const label = (date: string) => formatIn(parseDateTimeLocal(`${date}T12:00`, zone)!, "MMM d", zone);

  return (
    <div className="space-y-6">
      <PageHeader title="Team" description="Hours from the clock on My Day. No location is recorded." />

      <TeamTabs active="clock" members={memberCount} groups={groupCount} />

      {openNow.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader title="On the clock now" />
          <Table>
            <THead>
              <Th>Who</Th>
              <Th>Since</Th>
              <Th className="hidden sm:table-cell">Working on</Th>
            </THead>
            <TBody>
              {openNow.map((entry) => {
                const timer = timers.find((t) => t.userId === entry.user.id);
                return (
                  <Tr key={entry.id}>
                    <Td className="font-medium">{entry.user.name}</Td>
                    <Td className="tabular whitespace-nowrap text-ink-muted">
                      {formatIn(entry.clockedInAt, todayIn(zone) === formatIn(entry.clockedInAt, "yyyy-MM-dd", zone) ? "h:mm a" : "EEE, MMM d h:mm a", zone)}
                    </Td>
                    <Td className="hidden text-ink-muted sm:table-cell">
                      {timer ? (
                        <Link href={`/jobs/${timer.job.id}`} className="hover:text-brand">
                          {timer.job.number} · {timer.job.title}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </Card>
      ) : null}

      <div className="flex items-center gap-2">
        <Link href={`/team/time-clock?week=${week.previous}`} className={buttonClasses("outline", "icon")} aria-label="Previous week">
          <ChevronLeft className="h-4 w-4" strokeWidth={2} />
        </Link>
        <p className="tabular min-w-0 flex-1 text-center text-sm font-medium text-ink sm:flex-none sm:px-3">
          {label(week.first)} – {label(week.last)}
        </p>
        <Link href={`/team/time-clock?week=${week.next}`} className={buttonClasses("outline", "icon")} aria-label="Next week">
          <ChevronRight className="h-4 w-4" strokeWidth={2} />
        </Link>
      </div>

      {entries.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Clock className="h-5 w-5" strokeWidth={1.75} />}
            title="Nobody clocked in this week"
            description="The crew clock in and out on My Day; their hours show up here."
          />
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <CardHeader title="Hours this week" />
            <Table>
              <THead>
                <Th>Who</Th>
                <Th align="right">Days</Th>
                <Th align="right">Hours</Th>
              </THead>
              <TBody>
                {people.map((person) => (
                  <Tr key={person.id}>
                    <Td className="font-medium">{person.name}</Td>
                    <Td align="right" className="tabular text-ink-muted">
                      {person.days.size}
                    </Td>
                    <Td align="right" className="tabular font-semibold">
                      {formatMinutes(person.minutes)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Every entry" description="Newest first." />
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <ClockEntryRow key={row.id} row={row} canFix={can(user, "jobs:assign")} />
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Clock } from "lucide-react";

import { AddClockEntry } from "./add-entry";
import { ClockEntryRow } from "./entry-row";
import { TeamTabs } from "../tabs";
import { clockRow } from "@/components/timesheet/clock-row";
import { RangeBar } from "@/components/timesheet/range-bar";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import {
  columnMinutes,
  entryDefaults,
  loadTimesheets,
  rangeQuery,
  timesheetColumns,
  timesheetPresets,
  timesheetRange,
} from "@/lib/timesheet";
import { formatIn, todayIn } from "@/lib/time-zone";
import { cn, formatMinutes } from "@/lib/utils";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "Time clock" };

/** The most stretches listed one by one; a longer span sends the reader to a person's own sheet. */
const ENTRIES_SHOWN = 150;

/**
 * Team → Time clock: who is on the clock now, and everybody's hours for a
 * week or a pay period — a day at a time, with each person's total and how
 * much of it went on jobs. A name opens that person's timesheet. Whoever
 * schedules the crews can fix a stretch somebody forgot to close, or enter
 * one nobody clocked.
 */
export default async function TimeClockPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; week?: string }>;
}) {
  const { user, org } = await requirePermission("employees:read");
  const zone = await viewerTimeZone();
  const range = timesheetRange(await searchParams, zone);
  const now = new Date();
  const canFix = can(user, "jobs:assign");

  const [sheets, openNow, members, groupCount] = await Promise.all([
    loadTimesheets({ organizationId: org.id, range, zone, now }),
    prisma.clockEntry.findMany({
      where: { organizationId: org.id, clockedOutAt: null },
      orderBy: { clockedInAt: "asc" },
      select: { id: true, clockedInAt: true, user: { select: { id: true, name: true } } },
    }),
    prisma.user.findMany({
      where: { organizationId: org.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true, isActive: true },
    }),
    prisma.group.count({ where: { organizationId: org.id } }),
  ]);

  // What each person is timing right now, beside their name.
  const timers = await prisma.timeEntry.findMany({
    where: { organizationId: org.id, endedAt: null, userId: { in: openNow.map((entry) => entry.user.id) } },
    select: { userId: true, job: { select: { id: true, number: true, title: true } } },
  });

  const columns = timesheetColumns(range);
  const query = rangeQuery(range);
  const today = todayIn(zone);

  const everyone = columns.map((column) =>
    sheets.reduce((sum, sheet) => sum + columnMinutes(sheet, column).clock, 0),
  );
  // Time on a job on a day with nothing on the clock is shown in the day's
  // box, marked, rather than left out: it is still time somebody worked.
  const anyUnclocked = sheets.some((sheet) =>
    columns.some((column) => {
      const minutes = columnMinutes(sheet, column);
      return minutes.clock === 0 && minutes.job > 0;
    }),
  );

  const entries = sheets
    .flatMap((sheet) =>
      [...sheet.days.values()].flatMap((day) =>
        day.stretches.map((stretch) => ({ stretch, person: sheet.person.name })),
      ),
    )
    .sort((a, b) => b.stretch.clockedInAt.getTime() - a.stretch.clockedInAt.getTime());

  const addEntry = canFix ? (
    <AddClockEntry people={members.filter((member) => member.isActive)} {...entryDefaults(range, zone, now)} />
  ) : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Team" description="Hours from the clock on My Day. No location is recorded." />

      <TeamTabs active="clock" members={members.length} groups={groupCount} />

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
                    <Td className="font-medium">
                      <Link href={`/team/time-clock/${entry.user.id}?${query}`} className="hover:text-brand">
                        {entry.user.name}
                      </Link>
                    </Td>
                    <Td className="tabular whitespace-nowrap text-ink-muted">
                      {formatIn(entry.clockedInAt, today === formatIn(entry.clockedInAt, "yyyy-MM-dd", zone) ? "h:mm a" : "EEE, MMM d h:mm a", zone)}
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

      <RangeBar path="/team/time-clock" range={range} presets={timesheetPresets(zone)} />

      {sheets.length === 0 ? (
        <Card className="overflow-hidden">
          <EmptyState
            icon={<Clock className="h-5 w-5" strokeWidth={1.75} />}
            title="Nobody clocked in during these days"
            description="The crew clock in and out on My Day; their hours show up here."
          />
          {addEntry}
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <CardHeader
              title="Hours"
              description="Time on the clock, counted on the day a shift started. Open a name for the day-by-day timesheet."
            />
            {/* The totals come straight after the name, before the days: on a
                phone the table scrolls sideways, and what is on screen first
                should be who worked how long. */}
            <Table>
              <THead>
                <Th>Who</Th>
                <Th align="right">Total</Th>
                <Th align="right">On jobs</Th>
                {columns.map((column, index) => (
                  <Th key={column.key} align="right" className={cn("px-3", index === 0 && "border-l border-line")}>
                    {column.label}
                  </Th>
                ))}
              </THead>
              <TBody>
                {sheets.map((sheet) => (
                  <Tr key={sheet.person.id}>
                    <Td className="font-medium whitespace-nowrap">
                      <Link href={`/team/time-clock/${sheet.person.id}?${query}`} className="hover:text-brand">
                        {sheet.person.name}
                      </Link>
                    </Td>
                    <Td align="right" className="tabular font-semibold whitespace-nowrap">
                      {formatMinutes(sheet.clockMinutes)}
                    </Td>
                    <Td align="right" className="tabular whitespace-nowrap text-ink-muted">
                      {sheet.jobMinutes > 0 ? formatMinutes(sheet.jobMinutes) : "—"}
                    </Td>
                    {columns.map((column, index) => {
                      const minutes = columnMinutes(sheet, column);
                      return (
                        <Td
                          key={column.key}
                          align="right"
                          className={cn("tabular px-3 whitespace-nowrap", index === 0 && "border-l border-line")}
                        >
                          {minutes.clock > 0 ? (
                            formatMinutes(minutes.clock)
                          ) : minutes.job > 0 ? (
                            <span className="text-ink-subtle italic">{formatMinutes(minutes.job)}*</span>
                          ) : (
                            <span className="text-ink-subtle">—</span>
                          )}
                        </Td>
                      );
                    })}
                  </Tr>
                ))}
                {sheets.length > 1 ? (
                  <Tr className="bg-surface-2">
                    <Td className="font-semibold">Everyone</Td>
                    <Td align="right" className="tabular font-semibold whitespace-nowrap">
                      {formatMinutes(sheets.reduce((sum, sheet) => sum + sheet.clockMinutes, 0))}
                    </Td>
                    <Td align="right" className="tabular whitespace-nowrap text-ink-muted">
                      {formatMinutes(sheets.reduce((sum, sheet) => sum + sheet.jobMinutes, 0))}
                    </Td>
                    {everyone.map((minutes, index) => (
                      <Td
                        key={columns[index].key}
                        align="right"
                        className={cn("tabular px-3 font-medium whitespace-nowrap", index === 0 && "border-l border-line")}
                      >
                        {minutes > 0 ? formatMinutes(minutes) : <span className="text-ink-subtle">—</span>}
                      </Td>
                    ))}
                  </Tr>
                ) : null}
              </TBody>
            </Table>
            {anyUnclocked ? (
              <p className="border-t border-line px-5 py-2.5 text-xs text-ink-subtle">
                * Time put on a job on a day with nothing on the clock. It is not in the totals.
              </p>
            ) : null}
            {addEntry}
          </Card>

          {entries.length > 0 ? (
            <Card className="overflow-hidden">
              <CardHeader
                title="Every entry"
                description={
                  entries.length > ENTRIES_SHOWN
                    ? `The newest ${ENTRIES_SHOWN} of ${entries.length}. Open a name above for all of one person's.`
                    : "Newest first."
                }
              />
              <ul className="divide-y divide-line">
                {entries.slice(0, ENTRIES_SHOWN).map(({ stretch, person }) => (
                  <ClockEntryRow key={stretch.id} row={clockRow(stretch, person, zone)} canFix={canFix} />
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

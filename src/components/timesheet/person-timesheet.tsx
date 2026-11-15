import Link from "next/link";
import { Clock } from "lucide-react";

import { clockRow } from "./clock-row";
import { ClockEntryRow } from "@/app/(app)/team/time-clock/entry-row";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { dateLabel, type PersonSheet, type SheetDay, type TimesheetRange } from "@/lib/timesheet";
import { formatMinutes } from "@/lib/utils";

/** Up to two weeks every day is listed, days off included; past that, only the days worked. */
const EVERY_DAY_UP_TO = 14;

/**
 * One person's timesheet: the totals, each day with its stretches on the
 * clock and the jobs the time went on, and the split by job for the span.
 *
 * The same sheet whoever reads it. A manager's copy can fix a stretch; the
 * crew's own copy cannot — they see what payroll sees, and ask the office to
 * change it.
 */
export function PersonTimesheet({
  sheet,
  range,
  zone,
  canFix,
  linkJobs,
  jobLabel,
  emptyHint,
}: {
  /** Undefined when the person has no time in the span. */
  sheet: PersonSheet | undefined;
  range: TimesheetRange;
  zone: string;
  canFix: boolean;
  /** Whether a job's name leads to the job: only for somebody who can open any job. */
  linkJobs: boolean;
  /** What this business calls a job. */
  jobLabel: string;
  emptyHint: string;
}) {
  const dates =
    range.days.length <= EVERY_DAY_UP_TO ? range.days : range.days.filter((date) => sheet?.days.has(date));

  return (
    <div className="space-y-6">
      <Card>
        <div className="grid grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
          <Figure label="On the clock" value={formatMinutes(sheet?.clockMinutes ?? 0)} />
          <Figure label="Days worked" value={String(sheet?.daysWorked ?? 0)} />
          <Figure label="On jobs" value={formatMinutes(sheet?.jobMinutes ?? 0)} />
          <Figure label="Not on a job" value={formatMinutes(sheet?.offJobMinutes ?? 0)} />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Day by day" description="A shift counts on the day it started." />
        {!sheet ? (
          <EmptyState
            icon={<Clock className="h-5 w-5" strokeWidth={1.75} />}
            title="Nothing on the clock in these days"
            description={emptyHint}
          />
        ) : (
          <ul className="divide-y divide-line">
            {dates.map((date) => (
              <DayRow
                key={date}
                date={date}
                day={sheet.days.get(date)}
                person={sheet.person.name}
                zone={zone}
                canFix={canFix}
                linkJobs={linkJobs}
              />
            ))}
          </ul>
        )}
      </Card>

      {sheet && sheet.byJob.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader title="Where the time went" description="From timers, and from time logged by hand." />
          <Table>
            <THead>
              <Th>{jobLabel}</Th>
              <Th align="right">Hours</Th>
            </THead>
            <TBody>
              {sheet.byJob.map((job) => (
                <Tr key={job.id}>
                  <Td className="font-medium">
                    <JobName job={job} link={linkJobs} />
                  </Td>
                  <Td align="right" className="tabular whitespace-nowrap">
                    {formatMinutes(job.minutes)}
                  </Td>
                </Tr>
              ))}
              {sheet.offJobMinutes > 0 ? (
                <Tr>
                  <Td className="text-ink-muted">Not on a job</Td>
                  <Td align="right" className="tabular whitespace-nowrap text-ink-muted">
                    {formatMinutes(sheet.offJobMinutes)}
                  </Td>
                </Tr>
              ) : null}
            </TBody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}

function DayRow({
  date,
  day,
  person,
  zone,
  canFix,
  linkJobs,
}: {
  date: string;
  /** Undefined for a day with nothing on it. */
  day: SheetDay | undefined;
  person: string;
  zone: string;
  canFix: boolean;
  linkJobs: boolean;
}) {
  const label = dateLabel(date, "EEE, MMM d");

  if (!day) {
    return (
      <li className="flex items-center gap-4 px-5 py-2.5 text-sm text-ink-subtle">
        <span className="min-w-0 flex-1">{label}</span>
        <span>—</span>
      </li>
    );
  }

  // Several timers on one job in a day are one line: the job, and its time.
  const jobs = new Map<string, { job: SheetDay["jobTimes"][number]["job"]; minutes: number; running: boolean }>();
  for (const time of day.jobTimes) {
    const line = jobs.get(time.job.id) ?? { job: time.job, minutes: 0, running: false };
    line.minutes += time.minutes;
    line.running ||= time.running;
    jobs.set(time.job.id, line);
  }
  const clocked = day.stretches.length > 0;
  const offJob = Math.max(0, day.clockMinutes - day.jobMinutes);

  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="min-w-0 flex-1 text-sm font-semibold text-ink">{label}</p>
        {/* Time on a job with nothing on the clock: a day somebody forgot to clock in. */}
        {clocked ? null : <Badge tone="warning">Not clocked</Badge>}
        <span className="tabular text-sm font-semibold text-ink">
          {clocked ? formatMinutes(day.clockMinutes) : "—"}
        </span>
      </div>

      {clocked ? (
        <ul>
          {day.stretches.map((stretch) => (
            <ClockEntryRow
              key={stretch.id}
              row={clockRow(stretch, person, zone)}
              canFix={canFix}
              compact
              // One stretch is the whole day: its hours are the total above.
              hideHours={day.stretches.length === 1}
            />
          ))}
        </ul>
      ) : null}

      {jobs.size > 0 ? (
        <ul className="mt-1 space-y-1 border-l-2 border-line pl-3">
          {[...jobs.values()].map((line) => (
            <li key={line.job.id} className="flex items-center gap-3 text-xs text-ink-muted">
              <span className="min-w-0 flex-1 truncate">
                <JobName job={line.job} link={linkJobs} />
              </span>
              {line.running ? (
                <Badge tone="info" dot>
                  Timer running
                </Badge>
              ) : null}
              <span className="tabular whitespace-nowrap">{formatMinutes(line.minutes)}</span>
            </li>
          ))}
          {clocked && offJob > 0 ? (
            <li className="flex items-center gap-3 text-xs text-ink-subtle">
              <span className="min-w-0 flex-1">Not on a job</span>
              <span className="tabular whitespace-nowrap">{formatMinutes(offJob)}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function JobName({ job, link }: { job: { id: string; number: string; title: string }; link: boolean }) {
  const name = `${job.number} · ${job.title}`;
  return link ? (
    <Link href={`/jobs/${job.id}`} className="transition-colors hover:text-brand">
      {name}
    </Link>
  ) : (
    <>{name}</>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-5 py-3.5">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="tabular mt-0.5 text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}

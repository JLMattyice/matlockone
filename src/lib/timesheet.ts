import "server-only";

import { format } from "date-fns";

import { prisma } from "./db";
import { clockMinutes, timerMinutes } from "./time-clock";
import { formatIn, parseDateTimeLocal, todayIn } from "./time-zone";

/**
 * Timesheets: the hours behind a week or a pay period.
 *
 * Nothing new is stored for them. A person's hours are their stretches on the
 * day clock; the time they put on jobs — a timer, or time logged on the job —
 * says where those hours went. Read together over a span of days they make a
 * timesheet: hours each day, a total, and the split by job.
 *
 * A stretch counts on the day it began, on the clock of whoever is looking. A
 * shift that runs past midnight belongs to the day it started, the way a
 * paper timesheet has it, and the week's total is the same whichever page
 * adds it up.
 */

const DAY = 24 * 60 * 60 * 1000;
const DAY_KEY = "yyyy-MM-dd";

/** The longest span one page will add up: two months covers any pay period. */
export const TIMESHEET_MAX_DAYS = 62;

/** Past this many days the team table shows a column a week, not a column a day. */
const DAY_COLUMNS_UP_TO = 14;

// ---------------------------------------------------------------- dates ---
//
// Calendar dates are handled as "yyyy-MM-dd" text and stepped at noon UTC, so
// no daylight-saving change can land a step on the wrong day.

function noon(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

const key = (date: Date) => date.toISOString().slice(0, 10);

/** The calendar date `days` after `date`, or before it when negative. */
export function shiftDate(date: string, days: number) {
  return key(new Date(noon(date).getTime() + days * DAY));
}

/** A date somebody typed or a link carried, or null when it is not one. */
function realDate(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  // "2026-02-31" rolls over into March rather than failing; refuse it.
  return key(noon(value)) === value ? value : null;
}

/** The Sunday on or before a date: weeks run Sunday to Saturday, as the schedule draws them. */
function sundayOf(date: string) {
  return shiftDate(date, -noon(date).getUTCDay());
}

/** The first and last day of the month holding `date`, or of one `offset` months away. */
function monthOf(date: string, offset = 0) {
  const [year, month] = date.split("-").map(Number);
  return {
    from: key(new Date(Date.UTC(year, month - 1 + offset, 1, 12))),
    to: key(new Date(Date.UTC(year, month + offset, 0, 12))),
  };
}

/** A calendar date written out: `dateLabel("2026-11-09", "EEE d")` is "Mon 9". */
export function dateLabel(date: string, pattern: string) {
  const [year, month, day] = date.split("-").map(Number);
  // Built and read on the same clock, so the server's zone cannot move it.
  return format(new Date(year, month - 1, day, 12), pattern);
}

// ---------------------------------------------------------------- range ---

export type TimesheetSpan = { from: string; to: string };

export type TimesheetRange = TimesheetSpan & {
  /** Every day covered, first to last. */
  days: string[];
  /** The instants it starts and stops on the viewer's clock; `end` is not included. */
  start: Date;
  end: Date;
  /** The span of the same length before this one, and after. */
  previous: TimesheetSpan;
  next: TimesheetSpan;
};

/**
 * The span of days a timesheet page was asked for.
 *
 * `from` and `to` name it outright. Without them it is one Sunday-to-Saturday
 * week: the one holding `week` — the links this page made before it took a
 * span — or this week. Ends given backwards are swapped, and a span longer
 * than two months is cut to two.
 *
 * Stepping back and forward moves by the span's own length, so a pay period
 * set once walks period by period; a whole calendar month steps by months.
 */
export function timesheetRange(
  params: { from?: string; to?: string; week?: string },
  zone: string,
): TimesheetRange {
  let from = realDate(params.from);
  let to = realDate(params.to);

  if (!from && !to) {
    from = sundayOf(realDate(params.week) ?? todayIn(zone));
    to = shiftDate(from, 6);
  }
  // One end alone is that one day.
  from ??= to!;
  to ??= from;
  if (from > to) [from, to] = [to, from];

  const asked = Math.round((noon(to).getTime() - noon(from).getTime()) / DAY) + 1;
  const length = Math.min(TIMESHEET_MAX_DAYS, asked);
  to = shiftDate(from, length - 1);

  const first = from;
  const month = monthOf(first);
  const wholeMonth = month.from === first && month.to === to;

  return {
    from: first,
    to,
    days: Array.from({ length }, (_, index) => shiftDate(first, index)),
    start: parseDateTimeLocal(`${first}T00:00`, zone)!,
    end: parseDateTimeLocal(`${shiftDate(to, 1)}T00:00`, zone)!,
    previous: wholeMonth
      ? monthOf(first, -1)
      : { from: shiftDate(first, -length), to: shiftDate(to, -length) },
    next: wholeMonth
      ? monthOf(first, 1)
      : { from: shiftDate(first, length), to: shiftDate(to, length) },
  };
}

export type TimesheetPreset = TimesheetSpan & { label: string };

/** The spans people ask for by name, worked out from today on the viewer's clock. */
export function timesheetPresets(zone: string): TimesheetPreset[] {
  const today = todayIn(zone);
  const sunday = sundayOf(today);
  return [
    { label: "This week", from: sunday, to: shiftDate(sunday, 6) },
    { label: "Last week", from: shiftDate(sunday, -7), to: shiftDate(sunday, -1) },
    // The two whole weeks before this one: the pay period that just closed,
    // for a business that pays every other week.
    { label: "Last 2 weeks", from: shiftDate(sunday, -14), to: shiftDate(sunday, -1) },
    { label: "This month", ...monthOf(today) },
    { label: "Last month", ...monthOf(today, -1) },
  ];
}

/** "Nov 8 – Nov 14, 2026", or one date when the span is a single day. */
export function rangeLabel(range: TimesheetSpan) {
  if (range.from === range.to) return dateLabel(range.from, "EEE, MMM d, yyyy");
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return `${dateLabel(range.from, sameYear ? "MMM d" : "MMM d, yyyy")} – ${dateLabel(range.to, "MMM d, yyyy")}`;
}

/** The span as the query string a timesheet page reads back. */
export function rangeQuery(range: TimesheetSpan) {
  return `from=${range.from}&to=${range.to}`;
}

export type TimesheetColumn = {
  key: string;
  label: string;
  /** The days this column adds up: one, or a week's worth. */
  dates: string[];
};

/**
 * The columns of the team table: a day each up to two weeks, and past that a
 * week each — a month of day columns is a table nobody can read on a phone.
 */
export function timesheetColumns(range: TimesheetRange): TimesheetColumn[] {
  if (range.days.length <= DAY_COLUMNS_UP_TO) {
    return range.days.map((date) => ({ key: date, label: dateLabel(date, "EEE d"), dates: [date] }));
  }

  const weeks = new Map<string, string[]>();
  for (const date of range.days) {
    const sunday = sundayOf(date);
    weeks.set(sunday, [...(weeks.get(sunday) ?? []), date]);
  }
  return [...weeks.entries()].map(([sunday, dates]) => {
    const first = dates[0];
    const last = dates[dates.length - 1];
    const sameMonth = first.slice(0, 7) === last.slice(0, 7);
    return {
      key: sunday,
      label:
        first === last
          ? dateLabel(first, "MMM d")
          : `${dateLabel(first, "MMM d")}–${dateLabel(last, sameMonth ? "d" : "MMM d")}`,
      dates,
    };
  });
}

// ---------------------------------------------------------------- sheet ---

/** One stretch on the day clock. */
export type SheetStretch = {
  id: string;
  clockedInAt: Date;
  /** Null while still on the clock. */
  clockedOutAt: Date | null;
  minutes: number;
  /** Who corrected or entered it, when it was not the person's own tap. */
  editedBy: string | null;
  /** Still open from an earlier day: somebody forgot to clock out. */
  forgotten: boolean;
};

/** One piece of time on a job: a timer, or time logged on the job. */
export type SheetJobTime = {
  id: string;
  job: { id: string; number: string; title: string };
  startedAt: Date;
  minutes: number;
  /** A timer that has not been stopped. */
  running: boolean;
};

export type SheetDay = {
  date: string;
  clockMinutes: number;
  jobMinutes: number;
  stretches: SheetStretch[];
  jobTimes: SheetJobTime[];
};

export type PersonSheet = {
  person: { id: string; name: string };
  /** The days with anything on them, by date. A day off has no entry. */
  days: Map<string, SheetDay>;
  clockMinutes: number;
  jobMinutes: number;
  /** Clocked time that no job accounts for, added up a day at a time. */
  offJobMinutes: number;
  daysWorked: number;
  /** Where the job time went, most first. */
  byJob: { id: string; number: string; title: string; minutes: number }[];
  /** On the clock right now, in a stretch that began inside the span. */
  onClock: boolean;
};

/**
 * Everybody's timesheet for a span, or one person's when `userId` is given.
 * Only people with time in the span come back, in name order.
 */
export async function loadTimesheets({
  organizationId,
  range,
  zone,
  userId,
  now = new Date(),
}: {
  organizationId: string;
  range: Pick<TimesheetRange, "start" | "end">;
  zone: string;
  userId?: string;
  now?: Date;
}): Promise<PersonSheet[]> {
  const whose = userId ? { userId } : {};
  const person = { select: { id: true, name: true } } as const;

  // Job time is indexed by person, not by business. Naming the people keeps
  // the whole team's sheet on that index instead of reading every business's
  // entries to find this one's.
  const people = userId
    ? [userId]
    : (await prisma.user.findMany({ where: { organizationId }, select: { id: true } })).map((user) => user.id);

  const [stretches, jobTimes] = await Promise.all([
    prisma.clockEntry.findMany({
      where: { organizationId, ...whose, clockedInAt: { gte: range.start, lt: range.end } },
      orderBy: { clockedInAt: "asc" },
      select: {
        id: true,
        clockedInAt: true,
        clockedOutAt: true,
        user: person,
        editedBy: { select: { name: true } },
      },
    }),
    prisma.timeEntry.findMany({
      where: { organizationId, userId: { in: people }, startedAt: { gte: range.start, lt: range.end } },
      orderBy: { startedAt: "asc" },
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        minutes: true,
        user: person,
        job: { select: { id: true, number: true, title: true } },
      },
    }),
  ]);

  const today = formatIn(now, DAY_KEY, zone);
  const sheets = new Map<string, PersonSheet>();
  const jobTotals = new Map<string, Map<string, PersonSheet["byJob"][number]>>();

  const sheetFor = (who: { id: string; name: string }) => {
    let sheet = sheets.get(who.id);
    if (!sheet) {
      sheet = {
        person: who,
        days: new Map(),
        clockMinutes: 0,
        jobMinutes: 0,
        offJobMinutes: 0,
        daysWorked: 0,
        byJob: [],
        onClock: false,
      };
      sheets.set(who.id, sheet);
      jobTotals.set(who.id, new Map());
    }
    return sheet;
  };

  const dayFor = (sheet: PersonSheet, at: Date) => {
    const date = formatIn(at, DAY_KEY, zone);
    let day = sheet.days.get(date);
    if (!day) {
      day = { date, clockMinutes: 0, jobMinutes: 0, stretches: [], jobTimes: [] };
      sheet.days.set(date, day);
    }
    return day;
  };

  for (const stretch of stretches) {
    const sheet = sheetFor(stretch.user);
    const day = dayFor(sheet, stretch.clockedInAt);
    const minutes = clockMinutes(stretch, now);
    day.stretches.push({
      id: stretch.id,
      clockedInAt: stretch.clockedInAt,
      clockedOutAt: stretch.clockedOutAt,
      minutes,
      editedBy: stretch.editedBy?.name ?? null,
      forgotten: !stretch.clockedOutAt && day.date < today,
    });
    day.clockMinutes += minutes;
    sheet.clockMinutes += minutes;
    if (!stretch.clockedOutAt) sheet.onClock = true;
  }

  for (const time of jobTimes) {
    const sheet = sheetFor(time.user);
    const day = dayFor(sheet, time.startedAt);
    const minutes = timerMinutes(time, now);
    day.jobTimes.push({
      id: time.id,
      job: time.job,
      startedAt: time.startedAt,
      minutes,
      running: !time.endedAt,
    });
    day.jobMinutes += minutes;
    sheet.jobMinutes += minutes;

    const totals = jobTotals.get(time.user.id)!;
    const total = totals.get(time.job.id) ?? { ...time.job, minutes: 0 };
    total.minutes += minutes;
    totals.set(time.job.id, total);
  }

  for (const sheet of sheets.values()) {
    sheet.daysWorked = sheet.days.size;
    // A day at a time: an hour logged on a job on a day nobody clocked in must
    // not cancel an hour in the yard the day after.
    for (const day of sheet.days.values()) {
      sheet.offJobMinutes += Math.max(0, day.clockMinutes - day.jobMinutes);
    }
    sheet.byJob = [...jobTotals.get(sheet.person.id)!.values()].sort(
      (a, b) => b.minutes - a.minutes || a.number.localeCompare(b.number),
    );
  }

  return [...sheets.values()].sort((a, b) => a.person.name.localeCompare(b.person.name));
}

/**
 * Times to start an entry-by-hand from: eight to four on the last day shown,
 * or today when the span runs past it. Either comes back empty when it would
 * be in the future — nobody has clocked out of this afternoon yet.
 */
export function entryDefaults(range: TimesheetSpan, zone: string, now = new Date()) {
  const today = todayIn(zone);
  const day = range.to < today ? range.to : today;
  const past = (time: string) => {
    const value = `${day}T${time}`;
    const at = parseDateTimeLocal(value, zone);
    return at && at <= now ? value : "";
  };
  return { defaultIn: past("08:00"), defaultOut: past("16:00") };
}

/** What a column of the team table shows for one person. */
export function columnMinutes(sheet: PersonSheet, column: TimesheetColumn) {
  let clock = 0;
  let job = 0;
  for (const date of column.dates) {
    const day = sheet.days.get(date);
    if (!day) continue;
    clock += day.clockMinutes;
    job += day.jobMinutes;
  }
  return { clock, job };
}

/**
 * Entries that run over more than one day: a three-day roof, a trade show from
 * Friday to Sunday.
 *
 * Nothing new is stored for it. An entry already keeps when it starts and when
 * it ends, and one that ends on a later day than it starts covers every day in
 * between. The form asks for it the way people say it — "8 to 4, Monday to
 * Wednesday" — as a start, a length each day, and a last day; the end is that
 * last day at the start's time, plus the length.
 *
 * No `server-only`: the calendar is a client component and reads entries
 * through the same rules as the server.
 */

import { formatIn, parseDateTimeLocal } from "./time-zone";
import { durationMinutes } from "./utils";
import type { Prisma } from "@/generated/prisma/client";

const DAY_KEY = "yyyy-MM-dd";

/**
 * The first and last day an entry covers on the zone's clock, as "yyyy-MM-dd".
 *
 * An entry that ends exactly at midnight is over by then and does not reach
 * into the next day.
 */
export function entryDays(
  start: Date | string,
  end: Date | string | null | undefined,
  zone: string,
): { first: string; last: string } {
  const startAt = new Date(start);
  const first = formatIn(startAt, DAY_KEY, zone);
  if (!end) return { first, last: first };

  const endAt = new Date(end);
  if (!(endAt > startAt)) return { first, last: first };

  const last = formatIn(endAt.getTime() - 1, DAY_KEY, zone);
  return { first, last: last > first ? last : first };
}

/** Whether an entry ends on a later day than it starts, on the zone's clock. */
export function isMultiDay(
  start: Date | string,
  end: Date | string | null | undefined,
  zone: string,
): boolean {
  const { first, last } = entryDays(start, end, zone);
  return last > first;
}

/**
 * When an entry ends: `minutesPerDay` after it starts, or — given a last day
 * after the first — `minutesPerDay` after the same time on that last day.
 *
 * A last day that is blank, unreadable, or not after the start's day means
 * the entry is all on one day.
 */
export function scheduledEndFor(
  start: Date,
  minutesPerDay: number,
  lastDay: string | null | undefined,
  zone: string,
): Date {
  const oneDay = new Date(start.getTime() + minutesPerDay * 60_000);
  if (!lastDay || !/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) return oneDay;
  if (lastDay <= formatIn(start, DAY_KEY, zone)) return oneDay;

  const lastStart = parseDateTimeLocal(`${lastDay}T${formatIn(start, "HH:mm", zone)}`, zone);
  if (!lastStart) return oneDay;
  return new Date(lastStart.getTime() + minutesPerDay * 60_000);
}

/**
 * The form's view of a stored entry: its length each day, and its last day
 * when it runs over more than one (null when it is all on one day).
 *
 * The length each day is the one the form saved (`estimatedMinutes`). An
 * entry from before multi-day entries, or one whose length was never saved,
 * is read as one stretch from start to end — which is what it always was.
 */
export function scheduleShape(
  start: Date | null | undefined,
  end: Date | null | undefined,
  estimatedMinutes: number | null | undefined,
  zone: string,
): { lastDay: string | null; minutesPerDay: number } {
  const total = durationMinutes(start, end, estimatedMinutes ?? 60);
  if (!start || !end) return { lastDay: null, minutesPerDay: total };

  const perDay =
    estimatedMinutes && estimatedMinutes > 0 && estimatedMinutes < total ? estimatedMinutes : total;
  if (perDay === total) return { lastDay: null, minutesPerDay: total };

  const lastStart = new Date(end.getTime() - perDay * 60_000);
  const lastDay = formatIn(lastStart, DAY_KEY, zone);
  if (lastDay <= formatIn(start, DAY_KEY, zone)) return { lastDay: null, minutesPerDay: total };

  return { lastDay, minutesPerDay: perDay };
}

/**
 * The query for entries on the schedule at any point from `from` to `to`:
 * started by `to`, and not over before `from`. Asking only for a start inside
 * the range would lose the second day of a three-day job.
 *
 * Under AND, so it can sit beside a filter with an OR of its own.
 */
export function overlapsWhere(from: Date, to: Date) {
  return {
    AND: [
      { scheduledStart: { lte: to } },
      {
        OR: [
          { scheduledEnd: { gt: from } },
          { scheduledEnd: null, scheduledStart: { gte: from } },
        ],
      },
    ],
  } satisfies Prisma.JobWhereInput;
}

/** How many calendar days from `first` to `last`, both "yyyy-MM-dd", counting both. */
export function daysCovered(first: string, last: string): number {
  const ms = Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.max(1, Math.round(ms / 86_400_000) + 1) : 1;
}

/**
 * "Mon, Oct 5 – Wed, Oct 7", or "Mon, Dec 28, 2026 – Fri, Jan 1, 2027" when
 * it crosses into another year. For an entry on one day, that day alone.
 */
export function spanLabel(
  start: Date | string,
  end: Date | string | null | undefined,
  zone: string,
): string {
  const { first, last } = entryDays(start, end, zone);
  const endAt = end ? new Date(new Date(end).getTime() - 1) : new Date(start);
  if (last === first) return formatIn(start, "EEE, MMM d", zone);

  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  const pattern = sameYear ? "EEE, MMM d" : "EEE, MMM d, yyyy";
  return `${formatIn(start, pattern, zone)} – ${formatIn(endAt, pattern, zone)}`;
}

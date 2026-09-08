import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  getDate,
  setDate,
} from "date-fns";

import type { RecurrenceFrequency } from "./constants";

/**
 * Recurring appointments.
 *
 * Occurrences are generated as real Job rows up front rather than computed on
 * the fly, because every one of them can be rescheduled, assigned to a
 * different crew, or cancelled independently — which a virtual occurrence
 * cannot represent. `MAX_OCCURRENCES` bounds how far ahead a single rule can
 * write, so "every day, forever" cannot fill the table.
 */
export const MAX_OCCURRENCES = 60;

export type RecurrenceInput = {
  frequency: RecurrenceFrequency;
  interval: number;
  /** Weekday numbers, 0 = Sunday. WEEKLY only. */
  byWeekday?: number[];
  count?: number | null;
  until?: Date | null;
};

/**
 * Expands a rule into occurrence start times, always including `start` itself.
 * Returns at most `MAX_OCCURRENCES` dates.
 */
export function expandRecurrence(rule: RecurrenceInput, start: Date): Date[] {
  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const limit = Math.min(rule.count ?? MAX_OCCURRENCES, MAX_OCCURRENCES);
  const until = rule.until ?? null;

  if (rule.frequency === "WEEKLY" && rule.byWeekday?.length) {
    return expandWeekly(start, interval, rule.byWeekday, limit, until);
  }

  const dates: Date[] = [];
  let cursor = new Date(start);

  while (dates.length < limit) {
    if (until && cursor > until) break;
    dates.push(new Date(cursor));
    cursor = step(cursor, rule.frequency, interval, start);
  }

  return dates;
}

function step(
  cursor: Date,
  frequency: RecurrenceFrequency,
  interval: number,
  anchor: Date,
): Date {
  switch (frequency) {
    case "DAILY":
      return addDays(cursor, interval);
    case "WEEKLY":
      return addWeeks(cursor, interval);
    case "YEARLY":
      return addYears(cursor, interval);
    case "MONTHLY":
    default: {
      // Anchoring to the original day-of-month stops a run that starts on the
      // 31st from walking backwards (31 Jan -> 28 Feb -> 28 Mar) as it goes.
      const next = addMonths(cursor, interval);
      const wantedDay = getDate(anchor);
      const daysInNextMonth = getDate(
        new Date(next.getFullYear(), next.getMonth() + 1, 0),
      );
      return setDate(next, Math.min(wantedDay, daysInNextMonth));
    }
  }
}

/**
 * Weekly rules can name several weekdays ("every Tuesday and Thursday"), so
 * each qualifying week contributes more than one occurrence.
 */
function expandWeekly(
  start: Date,
  interval: number,
  byWeekday: number[],
  limit: number,
  until: Date | null,
): Date[] {
  const wanted = [...new Set(byWeekday)].sort((a, b) => a - b);
  const dates: Date[] = [];

  // Walk from the Sunday of the start's week so weeks advance predictably.
  let weekStart = addDays(start, -start.getDay());
  let weeksSeen = 0;

  while (dates.length < limit && weeksSeen < MAX_OCCURRENCES * 2) {
    for (const weekday of wanted) {
      const candidate = withTimeOf(addDays(weekStart, weekday), start);

      if (candidate < start) continue;
      if (until && candidate > until) return dates;
      if (dates.length >= limit) return dates;

      dates.push(candidate);
    }

    weekStart = addWeeks(weekStart, interval);
    weeksSeen++;
  }

  return dates;
}

function withTimeOf(date: Date, source: Date) {
  const out = new Date(date);
  out.setHours(
    source.getHours(),
    source.getMinutes(),
    source.getSeconds(),
    source.getMilliseconds(),
  );
  return out;
}

export function parseWeekdays(json: string | null | undefined): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
      : [];
  } catch {
    return [];
  }
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Plain-language summary of a rule, for the job header and calendar chips. */
export function describeRecurrence(rule: {
  frequency: string;
  interval: number;
  byWeekday?: string | null;
  count?: number | null;
  until?: Date | null;
}): string {
  const every =
    rule.interval > 1 ? `every ${rule.interval} ` : "every ";

  let base: string;
  switch (rule.frequency) {
    case "DAILY":
      base = `${every}${rule.interval > 1 ? "days" : "day"}`;
      break;
    case "WEEKLY": {
      const days = parseWeekdays(rule.byWeekday);
      base = days.length
        ? `${every}${rule.interval > 1 ? "weeks" : "week"} on ${days
            .map((d) => WEEKDAY_LABELS[d])
            .join(", ")}`
        : `${every}${rule.interval > 1 ? "weeks" : "week"}`;
      break;
    }
    case "MONTHLY":
      base = `${every}${rule.interval > 1 ? "months" : "month"}`;
      break;
    case "YEARLY":
      base = `${every}${rule.interval > 1 ? "years" : "year"}`;
      break;
    default:
      base = "repeats";
  }

  const capitalized = base.charAt(0).toUpperCase() + base.slice(1);
  if (rule.count) return `${capitalized}, ${rule.count} times`;
  return capitalized;
}

/**
 * The holidays the schedule marks, worked out from the date rather than kept
 * in a table: nothing to seed, nothing to fall out of date next year.
 *
 * United States only, which is where every business on Matlock One is. Two
 * sorts, and the calendar says which:
 *
 *  - federal: the eleven days banks, post offices and government close. One
 *    that lands on a weekend is also marked "(observed)" on the Friday before
 *    or the Monday after, the weekday those places actually close.
 *  - observance: days customers plan around that close nothing — Mother's
 *    Day, Halloween, Christmas Eve.
 *
 * Dates are "yyyy-MM-dd" strings, a day on the calendar with no clock or zone
 * attached, so the same holiday falls on the same square for everybody.
 *
 * Pure, and with no `server-only`: the calendar is a client component.
 */

export type HolidayKind = "federal" | "observance";

export type Holiday = {
  /** "2026-11-26" */
  date: string;
  name: string;
  kind: HolidayKind;
};

/**
 * Whether a business's country keeps these holidays. Every business is set
 * up in the United States today; one that says otherwise is not shown
 * somebody else's.
 */
export function showsUsHolidays(country: string | null | undefined): boolean {
  const value = (country ?? "").trim().toLowerCase().replace(/\./g, "");
  return ["", "us", "usa", "united states", "united states of america"].includes(value);
}

/** The holidays from `first` to `last`, both "yyyy-MM-dd" and inclusive, in date order. */
export function holidaysBetween(first: string, last: string): Holiday[] {
  const from = Number(first.slice(0, 4));
  const to = Number(last.slice(0, 4));
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return [];

  const found: Holiday[] = [];
  // A year either side, because an observed day can cross New Year: 1 January
  // on a Saturday is observed on the Friday before, the last day of the year.
  for (let year = from - 1; year <= to + 1; year++) {
    for (const holiday of holidaysIn(year)) {
      if (holiday.date >= first && holiday.date <= last) found.push(holiday);
    }
  }
  return found.sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b));
}

/** The holidays on one day, "yyyy-MM-dd". */
export function holidaysOn(date: string): Holiday[] {
  return holidaysBetween(date, date);
}

/** Every holiday dated in `year`, observed days included. */
export function holidaysIn(year: number): Holiday[] {
  const federal = (date: string, name: string): Holiday => ({ date, name, kind: "federal" });
  const observance = (date: string, name: string): Holiday => ({ date, name, kind: "observance" });

  const fixed: Array<[month: number, day: number, name: string]> = [
    [1, 1, "New Year's Day"],
    // A federal holiday since 2021.
    ...(year >= 2021 ? [[6, 19, "Juneteenth"] as [number, number, string]] : []),
    [7, 4, "Independence Day"],
    [11, 11, "Veterans Day"],
    [12, 25, "Christmas Day"],
  ];

  const list: Holiday[] = [];
  for (const [month, day, name] of fixed) {
    list.push(federal(ymd(year, month, day), name));
    const observed = observedDate(year, month, day);
    if (observed) list.push(federal(observed, `${name} (observed)`));
  }

  const easter = easterSunday(year);

  list.push(
    federal(nthWeekday(year, 1, MONDAY, 3), "Martin Luther King Jr. Day"),
    federal(nthWeekday(year, 2, MONDAY, 3), "Presidents' Day"),
    federal(lastWeekday(year, 5, MONDAY), "Memorial Day"),
    federal(nthWeekday(year, 9, MONDAY, 1), "Labor Day"),
    federal(nthWeekday(year, 10, MONDAY, 2), "Columbus Day"),
    federal(nthWeekday(year, 11, THURSDAY, 4), "Thanksgiving Day"),

    observance(ymd(year, 2, 14), "Valentine's Day"),
    observance(ymd(year, 3, 17), "St. Patrick's Day"),
    observance(shift(easter, -2), "Good Friday"),
    observance(easter, "Easter Sunday"),
    observance(nthWeekday(year, 5, SUNDAY, 2), "Mother's Day"),
    observance(nthWeekday(year, 6, SUNDAY, 3), "Father's Day"),
    observance(ymd(year, 10, 31), "Halloween"),
    observance(ymd(year, 12, 24), "Christmas Eve"),
    observance(ymd(year, 12, 31), "New Year's Eve"),
  );

  return list;
}

/** Federal first when two share a day: it is the one that closes the bank. */
function rank(holiday: Holiday) {
  return holiday.kind === "federal" ? 0 : 1;
}

const SUNDAY = 0;
const MONDAY = 1;
const THURSDAY = 4;

/**
 * The weekday a fixed-date federal holiday is observed on when it falls at a
 * weekend, or null when it falls on a weekday and needs no second date.
 * Saturday moves back to Friday, Sunday on to Monday.
 */
function observedDate(year: number, month: number, day: number): string | null {
  const weekday = weekdayOf(year, month, day);
  if (weekday === 6) return shift(ymd(year, month, day), -1);
  if (weekday === 0) return shift(ymd(year, month, day), 1);
  return null;
}

/** The `n`th `weekday` of a month: the third Monday of January. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = weekdayOf(year, month, 1);
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return ymd(year, month, day);
}

/** The last `weekday` of a month: the last Monday of May. */
function lastWeekday(year: number, month: number, weekday: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekdayOf(year, month, lastDay);
  return ymd(year, month, lastDay - ((last - weekday + 7) % 7));
}

/**
 * Western Easter, by the anonymous Gregorian algorithm (Meeus, Jones,
 * Butcher): the first Sunday after the ecclesiastical full moon on or after
 * 21 March.
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

// Calendar arithmetic in UTC, where no day is 23 or 25 hours long.

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function shift(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return ymd(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Whose clock a time is read on: the machine of whoever is looking.
 *
 * The hosted app renders on servers set to UTC, which put something done at
 * 9 PM in North Carolina at "1:00 AM". So the browser says which zone it is in
 * — a cookie, written by <TimeZoneProvider> — and every instant the app shows
 * or takes in is read on that zone's clock: when a note was left, when a job
 * starts, where "today" begins. Client components are handed the same zone as
 * the server used, so their first render matches the server's HTML.
 *
 * Calendar dates typed into a form — an invoice's due date, the day an expense
 * was paid — are stored at noon and shown as they are. Any clock within eleven
 * hours of the one that stored them agrees on noon's date.
 *
 * No `server-only` here: the calendar and the other client components need it
 * too. The cookie is read in ./viewer-time-zone.
 */

import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

/** Set by the browser; read by the server on every request. */
export const TIME_ZONE_COOKIE = "mo_tz";

/** The schema's default for a business, and the answer before any browser has said. */
export const DEFAULT_TIME_ZONE = "America/New_York";

/** An IANA name only — nothing a cookie cannot hold as it is. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/** The zone if this runtime knows it, otherwise undefined. */
export function usableTimeZone(zone: string | null | undefined): string | undefined {
  if (!zone || !ZONE_NAME.test(zone)) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The same instant, read on the zone's clock: date-fns works in the zone from here on. */
export function inZone(date: Date | string | number, zone: string): TZDate {
  return new TZDate(new Date(date).getTime(), zone);
}

/** This moment on the zone's clock. */
export function nowIn(zone: string): TZDate {
  return inZone(Date.now(), zone);
}

/** date-fns `format`, on the zone's clock. */
export function formatIn(date: Date | string | number, pattern: string, zone: string) {
  return format(inZone(date, zone), pattern);
}

/**
 * A plain Date for the same instant. Prisma writes a date with toISOString(),
 * and a TZDate's carries its offset ("…T00:00:00.000-04:00") — which SQLite
 * would compare as text against the "Z" stamps it already holds.
 */
export function instant(date: Date): Date {
  return new Date(date.getTime());
}

/** "YYYY-MM-DDTHH:mm" for a datetime-local input, on the zone's clock. */
export function toDateTimeLocal(date: Date | null | undefined, zone: string): string {
  if (!date) return "";
  return formatIn(date, "yyyy-MM-dd'T'HH:mm", zone);
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Reads "2026-08-26T14:30" from a datetime-local input — or a bare
 * "2026-08-26", as midnight — as that wall-clock time in the zone. A string
 * that already says its offset ("…Z") is taken as the instant it names.
 */
export function parseDateTimeLocal(
  value: string | null | undefined,
  zone: string,
): Date | null {
  if (!value) return null;
  const match = LOCAL_DATE_TIME.exec(value.trim());
  if (!match) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const date = new TZDate(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    zone,
  );
  // An impossible date ("2026-02-31") rolls over rather than failing; refuse it.
  if (Number.isNaN(date.getTime()) || date.getDate() !== Number(day)) return null;
  return instant(date);
}

/** "2026-09-29": today's date on the zone's clock. */
export function todayIn(zone: string): string {
  return formatIn(Date.now(), "yyyy-MM-dd", zone);
}

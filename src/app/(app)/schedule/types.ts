import type { CategoryIcon, JobStatus } from "@/lib/constants";

/** What an entry is, when it is not a plain job: "Newsletter" and its mark. */
export type EventMark = { label: string; icon: CategoryIcon } | null;

/**
 * Calendar events cross into a client component, so times travel as ISO
 * strings. Passing Date objects through the RSC boundary works, but strings
 * keep the drag-and-drop payloads (which go through dataTransfer) consistent
 * with what the grid renders.
 */
export type CalendarEvent = {
  id: string;
  number: string;
  title: string;
  mark: EventMark;
  status: JobStatus;
  startISO: string;
  endISO: string;
  allDay: boolean;
  durationMinutes: number;
  clientName: string | null;
  location: string | null;
  crew: string[];
};

/** A job with no date yet, waiting to be dragged onto the grid. */
export type UnscheduledJob = {
  id: string;
  number: string;
  title: string;
  mark: EventMark;
  status: JobStatus;
  clientName: string | null;
  durationMinutes: number;
  crew: string[];
};

/**
 * A repeating bill on the day it comes due. Not a job: it cannot be dragged,
 * and it opens the expense rather than a job.
 *
 *   - upcoming: still to come, at last time's amount.
 *   - waiting: its date has come and the amount changes every time, so
 *     somebody has to enter the real bill.
 *   - paid: recorded for that date.
 */
export type CalendarBill = {
  key: string;
  title: string;
  /** "$1,500.00" — null for somebody who cannot see what the business spends. */
  amount: string | null;
  /** The bill's date, at noon, as the expense dates are kept. */
  dateISO: string;
  state: "upcoming" | "waiting" | "paid";
  /** Null for somebody who cannot open expenses. */
  href: string | null;
};

export type CalendarView = "day" | "week" | "month";

export const CALENDAR_VIEWS: CalendarView[] = ["day", "week", "month"];

export function isCalendarView(value: unknown): value is CalendarView {
  return value === "day" || value === "week" || value === "month";
}

/** The grid renders this window; events outside it are clamped into view. */
export const GRID_START_HOUR = 6;
export const GRID_END_HOUR = 21;
export const HOUR_HEIGHT = 56;
export const SNAP_MINUTES = 15;

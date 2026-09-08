import type { JobStatus } from "@/lib/constants";

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
  kind: string;
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
  status: JobStatus;
  clientName: string | null;
  durationMinutes: number;
  crew: string[];
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

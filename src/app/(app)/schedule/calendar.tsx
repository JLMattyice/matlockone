"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Banknote, Check, ChevronLeft, ChevronRight, PenLine } from "lucide-react";
import {
  addDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  set,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";

import { layoutDay, layoutDayItems, type DayItem, type PlacedItem } from "./layout-events";
import {
  GRID_END_HOUR,
  GRID_START_HOUR,
  HOUR_HEIGHT,
  SNAP_MINUTES,
  type CalendarBill,
  type CalendarEvent,
  type CalendarView,
  type UnscheduledJob,
} from "./types";
import { rescheduleJob } from "../jobs/actions";
import { CategoryMark } from "../jobs/category-mark";
import { useTimeZone } from "@/components/app-shell/time-zone";
import { JOB_STATUS_META } from "@/lib/constants";
import type { Holiday } from "@/lib/holidays";
import { daysCovered, entryDays, isMultiDay, spanLabel } from "@/lib/schedule-span";
import { formatIn, inZone, instant } from "@/lib/time-zone";
import { cn } from "@/lib/utils";

/*
 * Every day, hour and "today" here is on the clock of the viewer's time zone,
 * which the server rendered in too: `anchor` and the days made from it are
 * TZDates, so date-fns works in that zone, and event times are read into it
 * before they are compared or placed.
 */

const DRAG_TYPE = "application/x-matlockone-job";

type DragPayload = {
  id: string;
  durationMinutes: number;
  /** Minutes between the event's start and where the pointer grabbed it. */
  grabOffsetMinutes: number;
  /**
   * Days between the entry's first day and the day it was grabbed by — for a
   * bar across several days, so the day under the pointer is the one that
   * lands where it is dropped.
   */
  grabOffsetDays?: number;
};

/** "2026-10-05": a day on the viewer's clock, the key everything is matched on. */
const dayKey = (day: Date) => format(day, "yyyy-MM-dd");

export function ScheduleCalendar({
  view,
  anchorISO,
  events: initialEvents,
  bills = [],
  holidays = [],
  unscheduled,
  canDrag,
  canCreate,
}: {
  view: CalendarView;
  anchorISO: string;
  events: CalendarEvent[];
  /** Repeating bills on their due dates, for the roles the owner chose. */
  bills?: CalendarBill[];
  /** Holidays in the range on screen, marked on their days. */
  holidays?: Holiday[];
  unscheduled: UnscheduledJob[];
  canDrag: boolean;
  canCreate: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [events, setEvents] = useState(initialEvents);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // The server is the source of truth; re-sync whenever it sends a new set.
  useEffect(() => setEvents(initialEvents), [initialEvents]);

  const zone = useTimeZone();
  const anchor = inZone(anchorISO, zone);

  /**
   * Moves the event locally first so the block follows the drop immediately,
   * then asks the server. A rejected move is rolled back.
   */
  function move(id: string, at: Date, durationMinutes: number) {
    const previous = events;
    const start = instant(at);
    const end = new Date(start.getTime() + durationMinutes * 60_000);

    setEvents((current) =>
      current.map((event) =>
        event.id === id
          ? {
              ...event,
              startISO: start.toISOString(),
              endISO: end.toISOString(),
              durationMinutes,
            }
          : event,
      ),
    );
    setError(null);

    startTransition(async () => {
      const result = await rescheduleJob({
        id,
        startISO: start.toISOString(),
        durationMinutes,
      });

      if (!result.ok) {
        setEvents(previous);
        setError(result.error ?? "Could not move that.");
        return;
      }
      router.refresh();
    });
  }

  const holidaysByDay = useMemo(() => {
    const byDay = new Map<string, Holiday[]>();
    for (const holiday of holidays) {
      byDay.set(holiday.date, [...(byDay.get(holiday.date) ?? []), holiday]);
    }
    return byDay;
  }, [holidays]);

  const shared = {
    events,
    bills,
    holidaysByDay,
    canDrag,
    canCreate,
    dragging,
    setDragging,
    move,
  };

  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div
        className={cn(
          "grid gap-4",
          unscheduled.length > 0 && "lg:grid-cols-[minmax(0,1fr)_15rem]",
        )}
      >
        <div className="min-w-0">
          {view === "month" ? (
            <MonthGrid anchor={anchor} {...shared} />
          ) : (
            <TimeGrid
              days={
                view === "day"
                  ? [startOfDay(anchor)]
                  : eachDayOfInterval({
                      start: startOfWeek(anchor),
                      end: endOfWeek(anchor),
                    })
              }
              {...shared}
            />
          )}
        </div>

        {unscheduled.length > 0 ? (
          <UnscheduledPanel
            jobs={unscheduled}
            canDrag={canDrag}
            dragging={dragging}
            setDragging={setDragging}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Jobs with no date yet. Dragging one onto the grid is how it gets scheduled,
 * which is the same gesture as moving an existing job — so there is nothing
 * extra to learn.
 */
function UnscheduledPanel({
  jobs,
  canDrag,
  dragging,
  setDragging,
}: {
  jobs: UnscheduledJob[];
  canDrag: boolean;
  dragging: string | null;
  setDragging: (id: string | null) => void;
}) {
  return (
    <aside className="rounded-card border border-line bg-surface">
      <div className="border-b border-line px-3.5 py-2.5">
        <h2 className="text-sm font-semibold text-ink">Unscheduled</h2>
        <p className="text-xs text-ink-muted">
          {canDrag ? "Drag onto the calendar to book." : `${jobs.length} waiting`}
        </p>
      </div>

      <ul className="scrollbar-thin max-h-[34rem] space-y-1.5 overflow-y-auto p-2">
        {jobs.map((job) => (
          <li key={job.id}>
            <Link
              href={`/jobs/${job.id}`}
              draggable={canDrag}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(
                  DRAG_TYPE,
                  JSON.stringify({
                    id: job.id,
                    durationMinutes: job.durationMinutes,
                    grabOffsetMinutes: 0,
                  } satisfies DragPayload),
                );
                setDragging(job.id);
              }}
              onDragEnd={() => setDragging(null)}
              className={cn(
                "block rounded-lg border border-line bg-surface-2 px-2.5 py-2 transition-colors hover:border-line-strong",
                canDrag && "cursor-grab active:cursor-grabbing",
                dragging === job.id && "opacity-40",
              )}
            >
              <span className="tabular block text-[0.6875rem] text-ink-subtle">
                {job.number}
              </span>
              <span className="flex items-center gap-1 text-xs font-medium text-ink">
                {job.mark ? (
                  <CategoryMark icon={job.mark.icon} className="text-ink-subtle" />
                ) : null}
                <span className="truncate">{job.title}</span>
              </span>
              {job.clientName ? (
                <span className="block truncate text-[0.6875rem] text-ink-subtle">
                  {job.clientName}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ------------------------------------------------------------- time grid ---

type GridProps = {
  events: CalendarEvent[];
  bills: CalendarBill[];
  holidaysByDay: Map<string, Holiday[]>;
  canDrag: boolean;
  canCreate: boolean;
  dragging: string | null;
  setDragging: (id: string | null) => void;
  move: (id: string, start: Date, durationMinutes: number) => void;
};

/** A bill or an entry, laid on whole days rather than on the hours. */
type BandEntry = DayItem &
  ({ type: "bill"; bill: CalendarBill } | { type: "event"; event: CalendarEvent });

/**
 * The bills and entries that sit on whole days, bills first. `everything`
 * takes timed entries too, as the month does; the week and day take only the
 * all-day and multi-day ones, the rest having a place on the hours.
 */
function bandEntries(
  events: CalendarEvent[],
  bills: CalendarBill[],
  zone: string,
  everything: boolean,
): BandEntry[] {
  const billEntries = bills
    .slice()
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO))
    .map((bill): BandEntry => {
      const day = formatIn(bill.dateISO, "yyyy-MM-dd", zone);
      return { type: "bill", bill, key: `bill:${bill.key}`, first: day, last: day };
    });

  const eventEntries = events
    .filter(
      (event) => everything || event.allDay || isMultiDay(event.startISO, event.endISO, zone),
    )
    .sort((a, b) => a.startISO.localeCompare(b.startISO))
    .map((event): BandEntry => ({
      type: "event",
      event,
      key: event.id,
      ...entryDays(event.startISO, event.endISO, zone),
    }));

  return [...billEntries, ...eventEntries];
}

/** One line of the band: a chip's height and the gap under it. */
const CHIP_PX = 20;
const LANE_PX = 22;

/**
 * Where a bar sits: its lane, and across its columns. A bar that carries on
 * past an edge runs right up to it, so it reads as one bar across the rows.
 */
function barStyle(placed: PlacedItem<BandEntry>, columns: number, topPx: number) {
  const inset = (open: boolean) => (open ? 0 : 3);
  const left = inset(placed.fromBefore);
  const right = inset(placed.toAfter);
  return {
    position: "absolute",
    top: topPx + placed.lane * LANE_PX,
    height: CHIP_PX,
    left: `calc(${(placed.col / columns) * 100}% + ${left}px)`,
    width: `calc(${(placed.span / columns) * 100}% - ${left + right}px)`,
  } satisfies React.CSSProperties;
}

/** The days into an entry that the pointer grabbed a bar of `placed` at. */
function grabbedDay(
  e: React.DragEvent,
  placed: PlacedItem<BandEntry>,
  rowFirstDay: string,
): number {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const perDay = rect.width / placed.span;
  const within = perDay > 0 ? Math.floor((e.clientX - rect.left) / perDay) : 0;
  const before = placed.fromBefore ? daysCovered(placed.item.first, rowFirstDay) - 1 : 0;
  return Math.max(0, Math.min(placed.span - 1, within)) + before;
}

function TimeGrid({ days, ...props }: GridProps & { days: Date[] }) {
  const zone = useTimeZone();
  const scrollRef = useRef<HTMLDivElement>(null);

  // All-day and multi-day entries and bills sit above the hours, not at the
  // top of the scrolling grid: it opens at 8am, which would scroll them out of
  // sight. Multi-day ones run across the days they cover as one bar.
  const keys = days.map(dayKey);
  const band = layoutDayItems(bandEntries(props.events, props.bills, zone, false), keys);
  const hours = Array.from(
    { length: GRID_END_HOUR - GRID_START_HOUR },
    (_, i) => GRID_START_HOUR + i,
  );

  // Open on the working day rather than at 6am.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = (8 - GRID_START_HOUR) * HOUR_HEIGHT;
    }
  }, []);

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex border-b border-line">
        <div className="w-14 shrink-0" aria-hidden />
        {days.map((day) => {
          const holidays = props.holidaysByDay.get(dayKey(day)) ?? [];
          return (
            <div
              key={day.toISOString()}
              className={cn(
                "@container min-w-0 flex-1 border-l border-line px-1 py-2 text-center",
                isToday(day) && "bg-brand/5",
              )}
            >
              <p className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
                {format(day, "EEE")}
              </p>
              <p
                className={cn(
                  "tabular text-lg font-semibold",
                  isToday(day) ? "text-brand" : "text-ink",
                )}
              >
                {format(day, "d")}
              </p>
              {holidays.length > 0 ? (
                <HolidayLabel holidays={holidays} className="mx-auto mt-0.5 max-w-full" />
              ) : null}
            </div>
          );
        })}
      </div>

      {band.lanes > 0 ? (
        <div className="flex border-b border-line bg-surface-2">
          <div className="w-14 shrink-0 px-1 py-1.5 text-right text-[0.625rem] leading-tight text-ink-subtle">
            All day
          </div>
          <div
            className="relative min-w-0 flex-1"
            style={{ height: band.lanes * LANE_PX + 6 }}
          >
            {/* The day lines, under the bars. */}
            <div className="absolute inset-0 flex" aria-hidden>
              {days.map((day) => (
                <div key={day.toISOString()} className="flex-1 border-l border-line" />
              ))}
            </div>
            {band.placed.map((placed) =>
              placed.item.type === "bill" ? (
                <BillChip
                  key={placed.item.key}
                  bill={placed.item.bill}
                  style={barStyle(placed, days.length, 4)}
                />
              ) : (
                <EventChip
                  key={placed.item.key}
                  event={placed.item.event}
                  style={barStyle(placed, days.length, 4)}
                  fromBefore={placed.fromBefore}
                  toAfter={placed.toAfter}
                  canDrag={props.canDrag}
                  isDragging={props.dragging === placed.item.key}
                  onDragStart={(e) => {
                    const event = (placed.item as Extract<BandEntry, { type: "event" }>).event;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData(
                      DRAG_TYPE,
                      JSON.stringify({
                        id: event.id,
                        durationMinutes: event.durationMinutes,
                        grabOffsetMinutes: 0,
                        grabOffsetDays: grabbedDay(e, placed, keys[0]),
                      } satisfies DragPayload),
                    );
                    props.setDragging(event.id);
                  }}
                  onDragEnd={() => props.setDragging(null)}
                />
              ),
            )}
          </div>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="scrollbar-thin relative max-h-[38rem] overflow-y-auto"
      >
        <div className="flex">
          <div className="w-14 shrink-0">
            {hours.map((hour) => (
              <div
                key={hour}
                style={{ height: HOUR_HEIGHT }}
                className="relative border-b border-line/60"
              >
                <span className="absolute -top-2 right-2 text-[0.6875rem] text-ink-subtle">
                  {formatHour(hour)}
                </span>
              </div>
            ))}
          </div>

          {days.map((day) => (
            <DayColumn key={day.toISOString()} day={day} hours={hours} {...props} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  day,
  hours,
  events,
  canDrag,
  canCreate,
  dragging,
  setDragging,
  move,
}: GridProps & { day: Date; hours: number[] }) {
  const zone = useTimeZone();
  const columnRef = useRef<HTMLDivElement>(null);
  const [hoverTop, setHoverTop] = useState<number | null>(null);

  // Only timed entries on this one day: the rest are in the band above.
  const dayEvents = events.filter((event) =>
    isSameDay(inZone(event.startISO, zone), day),
  );
  const positioned = layoutDay(dayEvents, zone);

  function pointerMinutes(clientY: number) {
    const rect = columnRef.current!.getBoundingClientRect();
    const offsetPx = clientY - rect.top;
    const minutes = (offsetPx / HOUR_HEIGHT) * 60;
    return minutes;
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setHoverTop(null);

    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;

    let payload: DragPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const rawMinutes = pointerMinutes(e.clientY) - payload.grabOffsetMinutes;
    const snapped = Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES;
    const clamped = Math.max(
      0,
      Math.min(snapped, (GRID_END_HOUR - GRID_START_HOUR) * 60 - 15),
    );

    // Wall-clock hours and minutes, so a slot means the same time on the day
    // the clocks change as on any other. A bar grabbed by its third day puts
    // that day here, and starts two days before.
    const start = set(addDays(day, -(payload.grabOffsetDays ?? 0)), {
      hours: GRID_START_HOUR + Math.floor(clamped / 60),
      minutes: clamped % 60,
      seconds: 0,
      milliseconds: 0,
    });

    move(payload.id, start, payload.durationMinutes);
  }

  return (
    <div className="relative flex-1 border-l border-line">
      <div
        ref={columnRef}
        className={cn("relative", isToday(day) && "bg-brand/[0.03]")}
        onDragOver={(e) => {
          if (!canDrag) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const minutes =
            Math.round(pointerMinutes(e.clientY) / SNAP_MINUTES) * SNAP_MINUTES;
          setHoverTop((minutes * HOUR_HEIGHT) / 60);
        }}
        onDragLeave={() => setHoverTop(null)}
        onDrop={onDrop}
      >
        {hours.map((hour) =>
          canCreate ? (
            <Link
              key={hour}
              href={`/jobs/new?date=${slotISO(day, hour)}`}
              style={{ height: HOUR_HEIGHT }}
              className="block border-b border-line/60 transition-colors hover:bg-brand/5"
              aria-label={`Schedule at ${formatHour(hour)} on ${format(day, "MMMM d")}`}
            />
          ) : (
            // Without jobs:write a slot link would only dead-end on /no-access.
            <div
              key={hour}
              style={{ height: HOUR_HEIGHT }}
              className="border-b border-line/60"
              aria-hidden
            />
          ),
        )}

        {hoverTop !== null ? (
          <div
            className="pointer-events-none absolute right-0 left-0 border-t-2 border-brand"
            style={{ top: hoverTop }}
            aria-hidden
          />
        ) : null}

        {positioned.map(({ event, topPx, heightPx, leftPct, widthPct }) => (
          <EventBlock
            key={event.id}
            event={event}
            style={{
              top: topPx,
              height: heightPx,
              left: `${leftPct}%`,
              width: `calc(${widthPct}% - 4px)`,
            }}
            canDrag={canDrag}
            isDragging={dragging === event.id}
            onDragStart={(e) => {
              const rect = (
                e.currentTarget as HTMLElement
              ).getBoundingClientRect();
              const grabOffsetMinutes =
                ((e.clientY - rect.top) / HOUR_HEIGHT) * 60;

              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData(
                DRAG_TYPE,
                JSON.stringify({
                  id: event.id,
                  durationMinutes: event.durationMinutes,
                  grabOffsetMinutes,
                } satisfies DragPayload),
              );
              setDragging(event.id);
            }}
            onDragEnd={() => setDragging(null)}
          />
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------- month grid ---

/** Lines of entries a month cell shows before "+N more". */
const MONTH_LANES = 3;
/** The cell's padding, the day number and the gap under it. */
const MONTH_HEADER_PX = 34;
const MONTH_MORE_PX = 18;
const MONTH_MIN_PX = 112;

function MonthGrid({
  anchor,
  events,
  bills,
  holidaysByDay,
  canDrag,
  dragging,
  setDragging,
  move,
}: GridProps & { anchor: Date }) {
  const zone = useTimeZone();
  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(anchor)),
    end: endOfWeek(endOfMonth(anchor)),
  });
  const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, i) =>
    days.slice(i * 7, i * 7 + 7),
  );
  const entries = bandEntries(events, bills, zone, true);
  const [hoverDay, setHoverDay] = useState<string | null>(null);

  /** The day of `week` under the pointer: the row, not the cell, takes the drop. */
  function dayUnder(e: React.DragEvent, week: Date[]) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const col = Math.floor(((e.clientX - rect.left) / rect.width) * 7);
    return week[Math.max(0, Math.min(6, col))];
  }

  function onDrop(e: React.DragEvent, week: Date[]) {
    e.preventDefault();
    setHoverDay(null);

    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;

    let payload: DragPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    // Month cells have no time axis, so the time of day is kept and only the
    // date changes. A bar grabbed by a later day keeps that day under the
    // pointer.
    const day = addDays(dayUnder(e, week), -(payload.grabOffsetDays ?? 0));
    const source = events.find((ev) => ev.id === payload.id);
    const original = inZone(source?.startISO ?? Date.now(), zone);
    const start = set(day, {
      hours: original.getHours(),
      minutes: original.getMinutes(),
      seconds: 0,
      milliseconds: 0,
    });

    move(payload.id, start, payload.durationMinutes);
  }

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="grid grid-cols-7 border-b border-line">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label) => (
          <div
            key={label}
            className="px-2 py-2 text-center text-xs font-medium tracking-wide text-ink-subtle uppercase"
          >
            {label}
          </div>
        ))}
      </div>

      {weeks.map((week) => {
        const keys = week.map(dayKey);
        const { placed, lanes } = layoutDayItems(entries, keys);
        const shown = placed.filter((entry) => entry.lane < MONTH_LANES);
        // Per day, what did not fit: everything on a lane below the third.
        const hidden = keys.map(
          (_, col) =>
            placed.filter(
              (entry) =>
                entry.lane >= MONTH_LANES && entry.col <= col && col < entry.col + entry.span,
            ).length,
        );
        const height = Math.max(
          MONTH_MIN_PX,
          MONTH_HEADER_PX +
            Math.min(lanes, MONTH_LANES) * LANE_PX +
            (hidden.some(Boolean) ? MONTH_MORE_PX : 0),
        );

        return (
          <div
            key={keys[0]}
            className="relative grid grid-cols-7"
            style={{ minHeight: height }}
            onDragOver={(e) => {
              if (!canDrag) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setHoverDay(dayKey(dayUnder(e, week)));
            }}
            onDragLeave={(e) => {
              // Leaving for one of the row's own bars is not leaving the row.
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setHoverDay((current) => (current && keys.includes(current) ? null : current));
            }}
            onDrop={(e) => onDrop(e, week)}
          >
            {week.map((day) => {
              const key = dayKey(day);
              const outside = !isSameMonth(day, anchor);
              const holidays = holidaysByDay.get(key) ?? [];

              return (
                <div
                  key={key}
                  className={cn(
                    "@container min-w-0 border-r border-b border-line p-1.5 transition-colors",
                    outside && "bg-surface-2/60",
                    isToday(day) && "bg-brand/5",
                    hoverDay === key && "bg-brand/10",
                  )}
                >
                  <div className="flex items-center gap-1">
                    <Link
                      href={`/schedule?view=day&date=${key}`}
                      className={cn(
                        "tabular flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors",
                        isToday(day)
                          ? "bg-brand text-brand-ink"
                          : outside
                            ? "text-ink-subtle hover:bg-surface-3"
                            : "text-ink hover:bg-surface-3",
                      )}
                    >
                      {format(day, "d")}
                    </Link>
                    {holidays.length > 0 ? (
                      <HolidayLabel holidays={holidays} className="ml-auto" />
                    ) : null}
                  </div>
                </div>
              );
            })}

            {shown.map((entry) =>
              entry.item.type === "bill" ? (
                <BillChip
                  key={entry.item.key}
                  bill={entry.item.bill}
                  style={barStyle(entry, 7, MONTH_HEADER_PX)}
                />
              ) : (
                <EventChip
                  key={entry.item.key}
                  event={entry.item.event}
                  style={barStyle(entry, 7, MONTH_HEADER_PX)}
                  fromBefore={entry.fromBefore}
                  toAfter={entry.toAfter}
                  canDrag={canDrag}
                  isDragging={dragging === entry.item.key}
                  onDragStart={(e) => {
                    const event = (entry.item as Extract<BandEntry, { type: "event" }>).event;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData(
                      DRAG_TYPE,
                      JSON.stringify({
                        id: event.id,
                        durationMinutes: event.durationMinutes,
                        grabOffsetMinutes: 0,
                        grabOffsetDays: grabbedDay(e, entry, keys[0]),
                      } satisfies DragPayload),
                    );
                    setDragging(event.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                />
              ),
            )}

            {hidden.map((count, col) =>
              count > 0 ? (
                <Link
                  key={keys[col]}
                  href={`/schedule?view=day&date=${keys[col]}`}
                  className="absolute truncate px-1.5 text-[0.6875rem] leading-[18px] text-ink-subtle hover:text-brand"
                  style={{
                    top: MONTH_HEADER_PX + MONTH_LANES * LANE_PX,
                    left: `${(col / 7) * 100}%`,
                    width: `${100 / 7}%`,
                  }}
                >
                  +{count} more
                </Link>
              ) : null,
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The holiday on a day, beside its date: green for a federal holiday, when
 * banks and post offices close, grey for a day that closes nothing.
 *
 * A day too narrow for the name — a week or a month on a phone — gets a dot
 * in its colour instead, with the name on hover and to a screen reader. The
 * width is the day's own (the nearest @container), not the screen's.
 */
function HolidayLabel({ holidays, className }: { holidays: Holiday[]; className?: string }) {
  const federal = holidays.some((holiday) => holiday.kind === "federal");
  const names = holidays.map((holiday) => holiday.name).join(" · ");
  const title = holidays
    .map((holiday) =>
      holiday.kind === "federal"
        ? `${holiday.name} — federal holiday: banks and post offices are closed`
        : holiday.name,
    )
    .join("\n");

  return (
    <span title={title} className={cn("block min-w-0", className)}>
      <span
        className={cn(
          "mx-auto block h-1.5 w-1.5 rounded-full @min-[5.5rem]:hidden",
          federal ? "bg-brand" : "bg-ink-subtle",
        )}
        aria-hidden
      />
      <span className="sr-only @min-[5.5rem]:hidden">{names}</span>
      <span
        className={cn(
          "hidden truncate rounded px-1 text-[0.625rem] leading-4 font-medium @min-[5.5rem]:block",
          federal ? "bg-brand/10 text-brand" : "bg-surface-3 text-ink-muted",
        )}
      >
        {names}
      </span>
    </span>
  );
}

// --------------------------------------------------------------- pieces ---

function EventBlock({
  event,
  style,
  canDrag,
  isDragging,
  onDragStart,
  onDragEnd,
}: {
  event: CalendarEvent;
  style: React.CSSProperties;
  canDrag: boolean;
  isDragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const zone = useTimeZone();
  const tone = JOB_STATUS_META[event.status].tone;

  return (
    <Link
      href={`/jobs/${event.id}`}
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={style}
      className={cn(
        "absolute overflow-hidden rounded-md border px-1.5 py-1 text-[0.6875rem] leading-tight transition-opacity",
        TONE_CLASSES[tone],
        canDrag && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
      title={[event.number, event.mark?.label, event.title].filter(Boolean).join(" · ")}
    >
      <span className="tabular flex items-center gap-1 font-semibold">
        {event.mark ? <CategoryMark icon={event.mark.icon} /> : null}
        {formatIn(event.startISO, "h:mm a", zone)}
      </span>
      <span className="block truncate font-medium">{event.title}</span>
      {event.clientName ? (
        <span className="block truncate opacity-80">{event.clientName}</span>
      ) : null}
    </Link>
  );
}

/**
 * An entry on whole days: a line in a month cell, or a bar across the days a
 * multi-day entry covers. A bar cut off at the edge of a week shows an arrow
 * there, for the days it carries on into.
 */
function EventChip({
  event,
  style,
  fromBefore = false,
  toAfter = false,
  canDrag = false,
  isDragging = false,
  onDragStart,
  onDragEnd,
}: {
  event: CalendarEvent;
  style?: React.CSSProperties;
  fromBefore?: boolean;
  toAfter?: boolean;
  canDrag?: boolean;
  isDragging?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const zone = useTimeZone();
  const tone = JOB_STATUS_META[event.status].tone;
  const multiDay = isMultiDay(event.startISO, event.endISO, zone);

  return (
    <Link
      href={`/jobs/${event.id}`}
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={style}
      className={cn(
        "flex items-center gap-1 overflow-hidden rounded border px-1.5 py-0.5 text-[0.6875rem] leading-tight",
        TONE_CLASSES[tone],
        fromBefore && "rounded-l-none border-l-0",
        toAfter && "rounded-r-none border-r-0",
        canDrag && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
      title={[
        event.number,
        event.mark?.label,
        event.title,
        multiDay ? spanLabel(event.startISO, event.endISO, zone) : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      {fromBefore ? <ChevronLeft className="-ml-1 h-3 w-3 shrink-0" strokeWidth={2} aria-hidden /> : null}
      {event.mark ? <CategoryMark icon={event.mark.icon} /> : null}
      {!event.allDay && !fromBefore ? (
        <span className="tabular shrink-0 font-semibold">
          {formatIn(event.startISO, "h:mm", zone)}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{event.title}</span>
      {toAfter ? (
        <ChevronRight className="-mr-1 ml-auto h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
      ) : null}
    </Link>
  );
}

const BILL_LOOK: Record<CalendarBill["state"], { className: string; label: string; Icon: typeof Banknote }> = {
  upcoming: { className: "border-dashed border-line-strong bg-surface text-ink", label: "Bill due", Icon: Banknote },
  waiting: { className: "border-warning/35 bg-warning/15 text-warning", label: "Enter this bill", Icon: PenLine },
  paid: { className: "border-success/30 bg-success/10 text-success", label: "Bill paid", Icon: Check },
};

/** A bill on its day: dashed while it is coming, amber to enter, green once paid. */
function BillChip({ bill, style }: { bill: CalendarBill; style?: React.CSSProperties }) {
  const look = BILL_LOOK[bill.state];
  const className = cn(
    "@container block overflow-hidden rounded border px-1.5 py-0.5 text-[0.6875rem] leading-tight",
    look.className,
    bill.href && "transition-colors hover:border-line-strong",
  );
  const title = `${look.label}: ${bill.title}${bill.amount ? `, ${bill.amount}` : ""}`;
  // The amount only where the chip has room for it beside the name: in a
  // narrow month cell the name matters more, and the hover text has both.
  const content = (
    <span className="flex items-center gap-1">
      <look.Icon className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
      <span className="truncate">{bill.title}</span>
      {bill.amount ? (
        <span className="tabular ml-auto hidden shrink-0 pl-1 opacity-80 @min-[10rem]:inline">{bill.amount}</span>
      ) : null}
    </span>
  );

  return bill.href ? (
    <Link href={bill.href} className={className} style={style} title={title} aria-label={title}>
      {content}
    </Link>
  ) : (
    <span className={className} style={style} title={title} aria-label={title}>
      {content}
    </span>
  );
}

const TONE_CLASSES: Record<string, string> = {
  info: "border-info/30 bg-info/12 text-info",
  accent: "border-brand/30 bg-brand/12 text-brand",
  warning: "border-warning/35 bg-warning/15 text-warning",
  success: "border-success/30 bg-success/12 text-success",
  danger: "border-danger/30 bg-danger/12 text-danger line-through",
  neutral: "border-line bg-surface-3 text-ink-muted",
};

function formatHour(hour: number) {
  const suffix = hour >= 12 ? "pm" : "am";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}${suffix}`;
}

function slotISO(day: Date, hour: number) {
  // The day's wall-clock date and the hour, not toISOString(): the new-job
  // form reads this as a time on the viewer's clock.
  return `${format(day, "yyyy-MM-dd")}T${String(hour).padStart(2, "0")}:00`;
}

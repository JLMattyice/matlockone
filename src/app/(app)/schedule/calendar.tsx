"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  addDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";

import { layoutDay } from "./layout-events";
import {
  GRID_END_HOUR,
  GRID_START_HOUR,
  HOUR_HEIGHT,
  SNAP_MINUTES,
  type CalendarEvent,
  type CalendarView,
  type UnscheduledJob,
} from "./types";
import { rescheduleJob } from "../jobs/actions";
import { JOB_STATUS_META } from "@/lib/constants";
import { cn } from "@/lib/utils";

const DRAG_TYPE = "application/x-matlockone-job";

type DragPayload = {
  id: string;
  durationMinutes: number;
  /** Minutes between the event's start and where the pointer grabbed it. */
  grabOffsetMinutes: number;
};

export function ScheduleCalendar({
  view,
  anchorISO,
  events: initialEvents,
  unscheduled,
  canDrag,
  canCreate,
}: {
  view: CalendarView;
  anchorISO: string;
  events: CalendarEvent[];
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

  const anchor = new Date(anchorISO);

  /**
   * Moves the event locally first so the block follows the drop immediately,
   * then asks the server. A rejected move is rolled back.
   */
  function move(id: string, start: Date, durationMinutes: number) {
    const previous = events;
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

  const shared = { events, canDrag, canCreate, dragging, setDragging, move };

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
              <span className="block truncate text-xs font-medium text-ink">
                {job.title}
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
  canDrag: boolean;
  canCreate: boolean;
  dragging: string | null;
  setDragging: (id: string | null) => void;
  move: (id: string, start: Date, durationMinutes: number) => void;
};

function TimeGrid({ days, ...props }: GridProps & { days: Date[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
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
        {days.map((day) => (
          <div
            key={day.toISOString()}
            className={cn(
              "flex-1 border-l border-line px-2 py-2 text-center",
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
          </div>
        ))}
      </div>

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
  const columnRef = useRef<HTMLDivElement>(null);
  const [hoverTop, setHoverTop] = useState<number | null>(null);

  const dayEvents = events.filter((event) =>
    isSameDay(new Date(event.startISO), day),
  );
  const positioned = layoutDay(dayEvents);
  const allDayEvents = dayEvents.filter((event) => event.allDay);

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

    const start = new Date(day);
    start.setHours(GRID_START_HOUR, 0, 0, 0);
    start.setMinutes(start.getMinutes() + clamped);

    move(payload.id, start, payload.durationMinutes);
  }

  return (
    <div className="relative flex-1 border-l border-line">
      {allDayEvents.length ? (
        <div className="space-y-1 border-b border-line bg-surface-2 p-1">
          {allDayEvents.map((event) => (
            <EventChip key={event.id} event={event} />
          ))}
        </div>
      ) : null}

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

function MonthGrid({
  anchor,
  events,
  canDrag,
  dragging,
  setDragging,
  move,
}: GridProps & { anchor: Date }) {
  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(anchor)),
    end: endOfWeek(endOfMonth(anchor)),
  });
  const [hoverDay, setHoverDay] = useState<string | null>(null);

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

      <div className="grid grid-cols-7">
        {days.map((day) => {
          const key = day.toISOString();
          const dayEvents = events
            .filter((event) => isSameDay(new Date(event.startISO), day))
            .sort(
              (a, b) =>
                new Date(a.startISO).getTime() - new Date(b.startISO).getTime(),
            );

          const outside = !isSameMonth(day, anchor);

          return (
            <div
              key={key}
              className={cn(
                "min-h-28 border-r border-b border-line p-1.5 transition-colors",
                outside && "bg-surface-2/60",
                isToday(day) && "bg-brand/5",
                hoverDay === key && "bg-brand/10",
              )}
              onDragOver={(e) => {
                if (!canDrag) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setHoverDay(key);
              }}
              onDragLeave={() => setHoverDay((c) => (c === key ? null : c))}
              onDrop={(e) => {
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

                // Month cells have no time axis, so the time of day is kept
                // and only the date changes.
                const source = events.find((ev) => ev.id === payload.id);
                const original = source ? new Date(source.startISO) : new Date();
                const start = new Date(day);
                start.setHours(
                  original.getHours(),
                  original.getMinutes(),
                  0,
                  0,
                );

                move(payload.id, start, payload.durationMinutes);
              }}
            >
              <div className="mb-1 flex items-center justify-between">
                <Link
                  href={`/schedule?view=day&date=${format(day, "yyyy-MM-dd")}`}
                  className={cn(
                    "tabular flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium transition-colors",
                    isToday(day)
                      ? "bg-brand text-brand-ink"
                      : outside
                        ? "text-ink-subtle hover:bg-surface-3"
                        : "text-ink hover:bg-surface-3",
                  )}
                >
                  {format(day, "d")}
                </Link>
              </div>

              <div className="space-y-1">
                {dayEvents.slice(0, 3).map((event) => (
                  <EventChip
                    key={event.id}
                    event={event}
                    canDrag={canDrag}
                    isDragging={dragging === event.id}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData(
                        DRAG_TYPE,
                        JSON.stringify({
                          id: event.id,
                          durationMinutes: event.durationMinutes,
                          grabOffsetMinutes: 0,
                        } satisfies DragPayload),
                      );
                      setDragging(event.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                  />
                ))}

                {dayEvents.length > 3 ? (
                  <Link
                    href={`/schedule?view=day&date=${format(day, "yyyy-MM-dd")}`}
                    className="block px-1 text-[0.6875rem] text-ink-subtle hover:text-brand"
                  >
                    +{dayEvents.length - 3} more
                  </Link>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
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
      title={`${event.number} · ${event.title}`}
    >
      <span className="tabular block font-semibold">
        {format(new Date(event.startISO), "h:mm a")}
      </span>
      <span className="block truncate font-medium">{event.title}</span>
      {event.clientName ? (
        <span className="block truncate opacity-80">{event.clientName}</span>
      ) : null}
    </Link>
  );
}

function EventChip({
  event,
  canDrag = false,
  isDragging = false,
  onDragStart,
  onDragEnd,
}: {
  event: CalendarEvent;
  canDrag?: boolean;
  isDragging?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const tone = JOB_STATUS_META[event.status].tone;

  return (
    <Link
      href={`/jobs/${event.id}`}
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.6875rem] leading-tight",
        TONE_CLASSES[tone],
        canDrag && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
      title={`${event.number} · ${event.title}`}
    >
      {!event.allDay ? (
        <span className="tabular shrink-0 font-semibold">
          {format(new Date(event.startISO), "h:mm")}
        </span>
      ) : null}
      <span className="truncate">{event.title}</span>
    </Link>
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
  const date = new Date(day);
  date.setHours(hour, 0, 0, 0);
  // Local parts, not toISOString(): the new-job form reads this as local time.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

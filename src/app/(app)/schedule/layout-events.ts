import type { CalendarEvent } from "./types";
import { GRID_START_HOUR, HOUR_HEIGHT } from "./types";
import { isMultiDay } from "@/lib/schedule-span";
import { inZone } from "@/lib/time-zone";

export type PositionedEvent = {
  event: CalendarEvent;
  topPx: number;
  heightPx: number;
  /** Percentages, so overlapping events share the column width. */
  leftPct: number;
  widthPct: number;
};

/**
 * Places a day's events on the time grid and side-by-side when they overlap.
 *
 * Events are packed into the leftmost lane that is already free at their start
 * time; the number of lanes in a cluster of mutually overlapping events sets
 * how wide each one is. This is the same approach a calendar app uses — without
 * it, two jobs at 9am would sit exactly on top of each other.
 *
 * Placed by the hour on the clock of `zone`, the viewer's.
 */
export function layoutDay(events: CalendarEvent[], zone: string): PositionedEvent[] {
  // All-day and multi-day entries sit in the band above the hours instead.
  const timed = events
    .filter((event) => !event.allDay && !isMultiDay(event.startISO, event.endISO, zone))
    .slice()
    .sort(
      (a, b) =>
        new Date(a.startISO).getTime() - new Date(b.startISO).getTime() ||
        b.durationMinutes - a.durationMinutes,
    );

  if (timed.length === 0) return [];

  const positioned: PositionedEvent[] = [];

  // A cluster is a run of events that transitively overlap. Width is decided
  // per cluster so an isolated event still gets the full column.
  let cluster: CalendarEvent[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;

    const lanes: number[] = []; // end time (ms) of the last event in each lane
    const laneOf = new Map<string, number>();

    for (const event of cluster) {
      const start = new Date(event.startISO).getTime();
      const end = new Date(event.endISO).getTime();

      let lane = lanes.findIndex((laneEnd) => laneEnd <= start);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(end);
      } else {
        lanes[lane] = end;
      }
      laneOf.set(event.id, lane);
    }

    const laneCount = Math.max(lanes.length, 1);

    for (const event of cluster) {
      const lane = laneOf.get(event.id) ?? 0;
      positioned.push({
        event,
        topPx: minutesFromGridStart(event.startISO, zone) * (HOUR_HEIGHT / 60),
        heightPx: Math.max(
          (event.durationMinutes * HOUR_HEIGHT) / 60,
          HOUR_HEIGHT / 3,
        ),
        leftPct: (lane / laneCount) * 100,
        widthPct: 100 / laneCount,
      });
    }

    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const event of timed) {
    const start = new Date(event.startISO).getTime();
    if (cluster.length > 0 && start >= clusterEnd) flush();

    cluster.push(event);
    clusterEnd = Math.max(clusterEnd, new Date(event.endISO).getTime());
  }
  flush();

  return positioned;
}

/** Anything that sits on whole days: a bill, an all-day entry, a multi-day one. */
export type DayItem = {
  key: string;
  /** "yyyy-MM-dd", both inclusive. */
  first: string;
  last: string;
};

export type PlacedItem<T extends DayItem> = {
  item: T;
  /** Column of the first visible day, and how many columns it covers. */
  col: number;
  span: number;
  /** Row inside the band; 0 is the top. */
  lane: number;
  /** It began before the first column, or runs on past the last. */
  fromBefore: boolean;
  toAfter: boolean;
};

/**
 * Lays whole-day items across a row of days — the all-day band above a week,
 * or one week of the month — as bars that keep to one line from end to end.
 *
 * Items go in the order of their first day, the longer first on the same day,
 * each into the highest lane free on every day it covers — so a three-day job
 * reads as one straight bar and the single-day items fill in around it. The
 * same packing a calendar app uses. Ties keep the order given, which is how
 * bills come before entries.
 *
 * Items wholly outside the row are left out; ones that cross its edges are cut
 * to it and say so, so the bar can show that it carries on.
 */
export function layoutDayItems<T extends DayItem>(
  items: T[],
  days: string[],
): { placed: PlacedItem<T>[]; lanes: number } {
  if (days.length === 0) return { placed: [], lanes: 0 };
  const firstDay = days[0];
  const lastDay = days[days.length - 1];

  const visible = items
    .filter((item) => item.last >= firstDay && item.first <= lastDay)
    .map((item, index) => {
      const fromBefore = item.first < firstDay;
      const toAfter = item.last > lastDay;
      const col = fromBefore ? 0 : days.indexOf(item.first);
      const end = toAfter ? days.length - 1 : days.indexOf(item.last);
      return { item, index, col, span: end - col + 1, fromBefore, toAfter };
    })
    // A day missing from the row (it never is) would give -1; leave it out
    // rather than draw it in the wrong place.
    .filter((entry) => entry.col >= 0 && entry.span >= 1)
    // Earlier first, then longer, then the order they were given in.
    .sort((a, b) => a.col - b.col || b.span - a.span || a.index - b.index);

  const taken: boolean[][] = []; // taken[lane][col]
  const placed: PlacedItem<T>[] = [];

  for (const entry of visible) {
    let lane = 0;
    while (taken[lane]?.slice(entry.col, entry.col + entry.span).some(Boolean)) lane++;
    taken[lane] ??= Array(days.length).fill(false);
    for (let col = entry.col; col < entry.col + entry.span; col++) taken[lane][col] = true;

    placed.push({
      item: entry.item,
      col: entry.col,
      span: entry.span,
      lane,
      fromBefore: entry.fromBefore,
      toAfter: entry.toAfter,
    });
  }

  return { placed, lanes: taken.length };
}

export function minutesFromGridStart(iso: string, zone: string) {
  const date = inZone(iso, zone);
  return date.getHours() * 60 + date.getMinutes() - GRID_START_HOUR * 60;
}

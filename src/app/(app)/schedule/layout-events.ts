import type { CalendarEvent } from "./types";
import { GRID_START_HOUR, HOUR_HEIGHT } from "./types";

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
 */
export function layoutDay(events: CalendarEvent[]): PositionedEvent[] {
  const timed = events
    .filter((event) => !event.allDay)
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
        topPx: minutesFromGridStart(event.startISO) * (HOUR_HEIGHT / 60),
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

export function minutesFromGridStart(iso: string) {
  const date = new Date(iso);
  return date.getHours() * 60 + date.getMinutes() - GRID_START_HOUR * 60;
}

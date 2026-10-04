import { describe, expect, it } from "vitest";

import { layoutDayItems } from "@/app/(app)/schedule/layout-events";
import {
  daysCovered,
  entryDays,
  isMultiDay,
  scheduledEndFor,
  scheduleShape,
  spanLabel,
} from "@/lib/schedule-span";
import { parseDateTimeLocal } from "@/lib/time-zone";

/**
 * Entries over several days store nothing new — a start and an end — so what
 * is pinned here is the reading of those two: which days they cover, how the
 * form's "8 to 4, Monday to Wednesday" becomes an end and back again, and how
 * the calendar lays them out as bars.
 */

const ZONE = "America/New_York";
const at = (value: string) => parseDateTimeLocal(value, ZONE)!;

describe("the days an entry covers", () => {
  it("is one day for an entry that ends the day it starts", () => {
    expect(entryDays(at("2026-10-05T08:00"), at("2026-10-05T16:00"), ZONE)).toEqual({
      first: "2026-10-05",
      last: "2026-10-05",
    });
    expect(isMultiDay(at("2026-10-05T08:00"), at("2026-10-05T16:00"), ZONE)).toBe(false);
  });

  it("runs to the day it ends on", () => {
    expect(entryDays(at("2026-10-05T08:00"), at("2026-10-07T16:00"), ZONE)).toEqual({
      first: "2026-10-05",
      last: "2026-10-07",
    });
  });

  it("does not reach into a day it ends at midnight of", () => {
    expect(entryDays(at("2026-10-05T22:00"), at("2026-10-06T00:00"), ZONE).last).toBe("2026-10-05");
  });

  it("reads the days on the viewer's clock", () => {
    // 11 PM Monday in New York is already Tuesday in UTC.
    const start = at("2026-10-05T23:00");
    expect(entryDays(start, null, ZONE).first).toBe("2026-10-05");
    expect(entryDays(start, null, "UTC").first).toBe("2026-10-06");
  });
});

describe("the form's last day", () => {
  it("ends on the last day at the start's time, plus the length", () => {
    const end = scheduledEndFor(at("2026-10-05T08:00"), 8 * 60, "2026-10-07", ZONE);
    expect(end).toEqual(at("2026-10-07T16:00"));
  });

  it("keeps the wall-clock time across a change of the clocks", () => {
    // Clocks go back on 1 November 2026.
    const end = scheduledEndFor(at("2026-10-30T08:00"), 60, "2026-11-02", ZONE);
    expect(end).toEqual(at("2026-11-02T09:00"));
  });

  it("is one day when the last day is blank or not after the start", () => {
    const start = at("2026-10-05T08:00");
    expect(scheduledEndFor(start, 90, null, ZONE)).toEqual(at("2026-10-05T09:30"));
    expect(scheduledEndFor(start, 90, "2026-10-05", ZONE)).toEqual(at("2026-10-05T09:30"));
    expect(scheduledEndFor(start, 90, "2026-10-01", ZONE)).toEqual(at("2026-10-05T09:30"));
  });

  it("reads back what the form saved", () => {
    const start = at("2026-10-05T08:00");
    const end = scheduledEndFor(start, 8 * 60, "2026-10-07", ZONE);
    expect(scheduleShape(start, end, 8 * 60, ZONE)).toEqual({
      lastDay: "2026-10-07",
      minutesPerDay: 480,
    });
  });

  it("reads an entry all on one day as it always was", () => {
    expect(scheduleShape(at("2026-10-05T08:00"), at("2026-10-05T10:00"), 120, ZONE)).toEqual({
      lastDay: null,
      minutesPerDay: 120,
    });
    // Saved before its length was, or moved by a drag: one stretch.
    expect(scheduleShape(at("2026-10-05T08:00"), at("2026-10-05T10:00"), null, ZONE)).toEqual({
      lastDay: null,
      minutesPerDay: 120,
    });
  });

  it("keeps a stretch through the night as one stretch", () => {
    // 10 PM to 2 AM: four hours, not "two days of four hours".
    const shape = scheduleShape(at("2026-10-05T22:00"), at("2026-10-06T02:00"), 240, ZONE);
    expect(shape).toEqual({ lastDay: null, minutesPerDay: 240 });
  });
});

describe("labels", () => {
  it("counts the days, both ends included", () => {
    expect(daysCovered("2026-10-05", "2026-10-05")).toBe(1);
    expect(daysCovered("2026-10-05", "2026-10-07")).toBe(3);
    expect(daysCovered("2026-10-30", "2026-11-02")).toBe(4);
  });

  it("says the range, with the year when it changes", () => {
    expect(spanLabel(at("2026-10-05T08:00"), at("2026-10-07T16:00"), ZONE)).toBe(
      "Mon, Oct 5 – Wed, Oct 7",
    );
    expect(spanLabel(at("2026-12-30T08:00"), at("2027-01-02T16:00"), ZONE)).toBe(
      "Wed, Dec 30, 2026 – Sat, Jan 2, 2027",
    );
  });
});

describe("whole-day bars", () => {
  const week = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"];
  const item = (key: string, first: string, last = first) => ({ key, first, last });

  it("runs a multi-day entry across its columns on one lane", () => {
    const { placed, lanes } = layoutDayItems([item("roof", "2026-10-05", "2026-10-07")], week);
    expect(lanes).toBe(1);
    expect(placed[0]).toMatchObject({ col: 1, span: 3, lane: 0, fromBefore: false, toAfter: false });
  });

  it("fills in single days around a bar, and stacks what overlaps", () => {
    const { placed, lanes } = layoutDayItems(
      [
        item("bill", "2026-10-06"),
        item("roof", "2026-10-05", "2026-10-07"),
        item("visit", "2026-10-08"),
      ],
      week,
    );
    const lane = (key: string) => placed.find((p) => p.item.key === key)!.lane;
    expect(lane("roof")).toBe(0);
    expect(lane("bill")).toBe(1);
    // Thursday is free on the top lane.
    expect(lane("visit")).toBe(0);
    expect(lanes).toBe(2);
  });

  it("cuts a bar at the edges of the row and says it carries on", () => {
    const { placed } = layoutDayItems([item("show", "2026-10-01", "2026-10-13")], week);
    expect(placed[0]).toMatchObject({ col: 0, span: 7, fromBefore: true, toAfter: true });
  });

  it("leaves out what falls outside the row", () => {
    expect(layoutDayItems([item("later", "2026-10-20")], week).placed).toEqual([]);
  });
});

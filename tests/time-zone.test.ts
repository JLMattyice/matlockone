import { describe, expect, it } from "vitest";

import { expandRecurrence } from "@/lib/recurrence";
import {
  formatIn,
  instant,
  inZone,
  parseDateTimeLocal,
  toDateTimeLocal,
  usableTimeZone,
} from "@/lib/time-zone";

/**
 * Times are read on the clock of whoever is looking, not the server's.
 *
 * The hosted app's servers run in UTC. Before this, something done at 9 PM in
 * New York showed as "1:00 AM", and a job booked for 9 AM was saved as 9 AM
 * UTC. Every case here pins an instant in UTC and a zone by name, so they give
 * the same answer on any machine.
 */

const NEW_YORK = "America/New_York";

describe("formatIn", () => {
  it("shows the evening as evening, not as the server's 1 AM", () => {
    const evening = new Date("2026-09-30T01:05:00Z");

    expect(formatIn(evening, "MMM d, h:mm a", NEW_YORK)).toBe("Sep 29, 9:05 PM");
    expect(formatIn(evening, "MMM d, h:mm a", "America/Los_Angeles")).toBe("Sep 29, 6:05 PM");
    expect(formatIn(evening, "MMM d, h:mm a", "UTC")).toBe("Sep 30, 1:05 AM");
  });

  it("follows daylight saving time", () => {
    // 2 PM UTC is 10 AM in New York in summer and 9 AM in winter.
    expect(formatIn(new Date("2026-07-01T14:00:00Z"), "h:mm a", NEW_YORK)).toBe("10:00 AM");
    expect(formatIn(new Date("2026-12-01T14:00:00Z"), "h:mm a", NEW_YORK)).toBe("9:00 AM");
  });
});

describe("parseDateTimeLocal", () => {
  it("reads what was typed as that time on the typist's clock", () => {
    expect(parseDateTimeLocal("2026-09-29T21:00", NEW_YORK)?.toISOString()).toBe(
      "2026-09-30T01:00:00.000Z",
    );
    expect(parseDateTimeLocal("2026-12-01T09:00", NEW_YORK)?.toISOString()).toBe(
      "2026-12-01T14:00:00.000Z",
    );
    expect(parseDateTimeLocal("2026-09-29T09:00", "Asia/Tokyo")?.toISOString()).toBe(
      "2026-09-29T00:00:00.000Z",
    );
  });

  it("round-trips with toDateTimeLocal", () => {
    const typed = "2026-11-01T08:30";
    const saved = parseDateTimeLocal(typed, NEW_YORK);
    expect(toDateTimeLocal(saved, NEW_YORK)).toBe(typed);
  });

  it("takes a bare date as midnight", () => {
    expect(parseDateTimeLocal("2026-09-29", NEW_YORK)?.toISOString()).toBe(
      "2026-09-29T04:00:00.000Z",
    );
  });

  it("takes a string that names its offset as the instant it names", () => {
    expect(parseDateTimeLocal("2026-09-29T13:00:00.000Z", NEW_YORK)?.toISOString()).toBe(
      "2026-09-29T13:00:00.000Z",
    );
  });

  it("refuses nothing, rubbish and dates that do not exist", () => {
    expect(parseDateTimeLocal("", NEW_YORK)).toBeNull();
    expect(parseDateTimeLocal(null, NEW_YORK)).toBeNull();
    expect(parseDateTimeLocal("next Tuesday", NEW_YORK)).toBeNull();
    expect(parseDateTimeLocal("2026-02-31T09:00", NEW_YORK)).toBeNull();
  });

  it("returns a plain Date, which Prisma writes as UTC", () => {
    const saved = parseDateTimeLocal("2026-09-29T21:00", NEW_YORK)!;
    expect(saved.constructor).toBe(Date);
    expect(saved.toISOString().endsWith("Z")).toBe(true);
  });
});

describe("instant", () => {
  it("drops the zone but keeps the moment", () => {
    const zoned = inZone(new Date("2026-09-30T01:05:00Z"), NEW_YORK);
    expect(zoned.toISOString()).not.toMatch(/Z$/);

    const plain = instant(zoned);
    expect(plain.constructor).toBe(Date);
    expect(plain.toISOString()).toBe("2026-09-30T01:05:00.000Z");
  });
});

describe("usableTimeZone", () => {
  it("accepts a real zone and refuses anything else", () => {
    expect(usableTimeZone(NEW_YORK)).toBe(NEW_YORK);
    expect(usableTimeZone("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(usableTimeZone("Mars/Olympus_Mons")).toBeUndefined();
    expect(usableTimeZone("x; path=/")).toBeUndefined();
    expect(usableTimeZone("")).toBeUndefined();
    expect(usableTimeZone(undefined)).toBeUndefined();
  });
});

describe("expandRecurrence in a zone", () => {
  it("keeps a 9 PM Tuesday job on Tuesdays, though the server calls it Wednesday", () => {
    const start = parseDateTimeLocal("2026-09-29T21:00", NEW_YORK)!; // a Tuesday
    const dates = expandRecurrence(
      { frequency: "WEEKLY", interval: 1, byWeekday: [2], count: 3 },
      start,
      NEW_YORK,
    );

    expect(dates.map((d) => formatIn(d, "EEE yyyy-MM-dd h:mm a", NEW_YORK))).toEqual([
      "Tue 2026-09-29 9:00 PM",
      "Tue 2026-10-06 9:00 PM",
      "Tue 2026-10-13 9:00 PM",
    ]);
  });

  it("keeps the same time of day across the change to standard time", () => {
    const start = parseDateTimeLocal("2026-10-26T09:00", NEW_YORK)!;
    const dates = expandRecurrence(
      { frequency: "WEEKLY", interval: 1, count: 3 },
      start,
      NEW_YORK,
    );

    // Clocks go back on November 1; the job stays at 9 on the wall.
    expect(dates.map((d) => formatIn(d, "MMM d h:mm a", NEW_YORK))).toEqual([
      "Oct 26 9:00 AM",
      "Nov 2 9:00 AM",
      "Nov 9 9:00 AM",
    ]);
    expect(dates.every((d) => d.constructor === Date)).toBe(true);
  });
});

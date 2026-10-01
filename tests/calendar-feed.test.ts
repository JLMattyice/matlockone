import { describe, expect, it } from "vitest";

import {
  addressLine,
  buildCalendarFeed,
  escapeText,
  foldLine,
  utcStamp,
  type FeedEntry,
  type FeedOptions,
} from "@/lib/calendar-feed";
import { newFeedToken, parseFeedPath } from "@/lib/calendar-feed-server";

/**
 * The calendar feed has three readers this suite cannot run — Google, Outlook
 * and Apple — so what is pinned here is the format they all read: escaping,
 * line folding, all-day dates, and what the file leaves out.
 */

const options: FeedOptions = {
  name: "Northside Home Services",
  timeZone: "America/New_York",
  now: new Date("2026-10-01T12:00:00Z"),
  domain: "www.matlockone.com",
};

function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: "job_1",
    number: "JOB-1042",
    title: "Ductwork cleaning",
    kindLabel: null,
    status: "SCHEDULED",
    start: new Date("2026-10-02T13:00:00Z"),
    end: new Date("2026-10-02T15:30:00Z"),
    allDay: false,
    estimatedMinutes: null,
    description: null,
    clientName: "Oscar Nakamura",
    address: "9056 Beaumont Ave, Kingsbury NC 27560",
    crew: ["Priya Raghavan", "Marcus Whitfield"],
    updatedAt: new Date("2026-09-30T18:00:00Z"),
    url: "https://www.matlockone.com/jobs/job_1",
    ...overrides,
  };
}

/** Unfolds and splits, the way a calendar app reads it. */
function lines(feed: string) {
  return feed.replace(/\r\n /g, "").split("\r\n");
}

describe("escapeText", () => {
  it("escapes the characters iCalendar reserves", () => {
    expect(escapeText("Smith, Jones; and Co\\")).toBe("Smith\\, Jones\\; and Co\\\\");
  });

  it("turns line breaks into \\n", () => {
    expect(escapeText("Gate code 4411\r\nDog in yard\nRing twice")).toBe(
      "Gate code 4411\\nDog in yard\\nRing twice",
    );
  });
});

describe("foldLine", () => {
  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:Short")).toBe("SUMMARY:Short");
  });

  it("keeps every physical line within 75 bytes", () => {
    const folded = foldLine(`DESCRIPTION:${"x".repeat(300)}`);
    for (const part of folded.split("\r\n")) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(`DESCRIPTION:${"x".repeat(300)}`);
  });

  it("never splits a character in two", () => {
    // Accented names are where a byte-blind fold turns into garbage.
    const line = `SUMMARY:${"é".repeat(80)}`;
    const folded = foldLine(line);

    expect(folded.replace(/\r\n /g, "")).toBe(line);
    for (const part of folded.split("\r\n")) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
      expect(part).not.toContain("�");
    }
  });
});

describe("utcStamp", () => {
  it("writes the basic UTC form", () => {
    expect(utcStamp(new Date("2026-10-02T13:05:09.123Z"))).toBe("20261002T130509Z");
  });
});

describe("buildCalendarFeed", () => {
  it("is a complete calendar with CRLF line endings", () => {
    const feed = buildCalendarFeed([entry()], options);

    expect(feed.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(feed.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(feed.replace(/\r\n/g, "")).not.toMatch(/\n/);
    expect(lines(feed)).toContain("VERSION:2.0");
    expect(lines(feed)).toContain("X-WR-CALNAME:Northside Home Services");
  });

  it("writes a timed entry in UTC with a stable id", () => {
    const out = lines(buildCalendarFeed([entry()], options));

    expect(out).toContain("UID:job_1@www.matlockone.com");
    expect(out).toContain("DTSTART:20261002T130000Z");
    expect(out).toContain("DTEND:20261002T153000Z");
    expect(out).toContain("SUMMARY:Ductwork cleaning · Oscar Nakamura");
    expect(out).toContain("LOCATION:9056 Beaumont Ave\\, Kingsbury NC 27560");
    expect(out).toContain("URL:https://www.matlockone.com/jobs/job_1");
  });

  it("gives an entry with no end its estimate, or an hour", () => {
    const estimated = lines(
      buildCalendarFeed([entry({ end: null, estimatedMinutes: 90 })], options),
    );
    expect(estimated).toContain("DTEND:20261002T143000Z");

    const bare = lines(buildCalendarFeed([entry({ end: null })], options));
    expect(bare).toContain("DTEND:20261002T140000Z");
  });

  it("dates an all-day entry on the business's calendar, ending the day after", () => {
    // 02:00 UTC on the 3rd is still the 2nd in New York.
    const out = lines(
      buildCalendarFeed(
        [entry({ allDay: true, start: new Date("2026-10-03T02:00:00Z"), end: null })],
        options,
      ),
    );

    expect(out).toContain("DTSTART;VALUE=DATE:20261002");
    expect(out).toContain("DTEND;VALUE=DATE:20261003");
    expect(out).toContain("TRANSP:TRANSPARENT");
  });

  it("spans every day of a multi-day all-day entry", () => {
    const out = lines(
      buildCalendarFeed(
        [
          entry({
            allDay: true,
            start: new Date("2026-10-05T14:00:00Z"),
            end: new Date("2026-10-07T14:00:00Z"),
          }),
        ],
        options,
      ),
    );

    expect(out).toContain("DTSTART;VALUE=DATE:20261005");
    expect(out).toContain("DTEND;VALUE=DATE:20261008");
  });

  it("puts the number, crew and a link back in the description", () => {
    const out = lines(
      buildCalendarFeed(
        [entry({ kindLabel: "Meeting", description: "Bring the ladder" })],
        options,
      ),
    );
    const description = out.find((line) => line.startsWith("DESCRIPTION:"))!;

    expect(description).toContain("JOB-1042 · Meeting");
    expect(description).toContain("Crew: Priya Raghavan\\, Marcus Whitfield");
    expect(description).toContain("Bring the ladder");
    expect(description).toContain("Open in Matlock One: https://www.matlockone.com/jobs/job_1");
  });

  it("cuts a long description rather than sending all of it", () => {
    const out = lines(
      buildCalendarFeed([entry({ description: "y".repeat(5000) })], options),
    );
    const description = out.find((line) => line.startsWith("DESCRIPTION:"))!;

    expect(description.length).toBeLessThan(1300);
    expect(description).toContain("…");
  });

  it("leaves cancelled entries out", () => {
    const feed = buildCalendarFeed(
      [entry({ id: "kept" }), entry({ id: "gone", status: "CANCELLED" })],
      options,
    );

    expect(feed).toContain("UID:kept@");
    expect(feed).not.toContain("UID:gone@");
  });

  it("is still a valid calendar with nothing booked", () => {
    const out = lines(buildCalendarFeed([], options));
    expect(out).toContain("BEGIN:VCALENDAR");
    expect(out).toContain("END:VCALENDAR");
    expect(out.some((line) => line === "BEGIN:VEVENT")).toBe(false);
  });

  it("carries no money", () => {
    // The feed lands in another company's service; it carries the schedule
    // and nothing else. Nothing here takes an amount, and that should stay so.
    const feed = buildCalendarFeed([entry()], options);
    expect(feed).not.toMatch(/\$\d/);
  });
});

describe("addressLine", () => {
  it("joins what is there and skips what is not", () => {
    expect(
      addressLine({
        line1: "1420 Beaumont Ave",
        line2: "Suite 210",
        city: "Millbrook",
        state: "NC",
        postalCode: "27502",
      }),
    ).toBe("1420 Beaumont Ave, Suite 210, Millbrook, NC 27502");
    expect(addressLine({ line1: "12 Elm St", city: null })).toBe("12 Elm St");
    expect(addressLine(null)).toBeNull();
  });
});

describe("feed addresses", () => {
  it("makes 32-character tokens that differ every time", () => {
    const a = newFeedToken();
    const b = newFeedToken();

    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });

  it("reads a person's feed and the whole-business feed", () => {
    const token = newFeedToken();

    expect(parseFeedPath(`${token}.ics`)).toEqual({ token, all: false });
    expect(parseFeedPath(`${token}-all.ics`)).toEqual({ token, all: true });
  });

  it("refuses anything else before it reaches the database", () => {
    const token = newFeedToken();

    for (const segment of [
      token,
      `${token}.txt`,
      `${token.slice(1)}.ics`,
      `${token}x.ics`,
      `${token}-everything.ics`,
      "../../etc.ics",
      "",
    ]) {
      expect(parseFeedPath(segment), segment).toBeNull();
    }
  });
});

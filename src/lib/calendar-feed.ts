import { addDays } from "date-fns";

import { formatIn, inZone } from "./time-zone";

/**
 * A schedule as an iCalendar file, for Google, Outlook and Apple Calendar to
 * subscribe to.
 *
 * One way only: the calendar app reads this every few hours and shows what it
 * finds, and nothing it does comes back. Two-way sync means each provider's
 * OAuth review and a copy of every entry kept in step on both sides; a feed
 * gets the schedule onto the phone everybody already looks at, which is most
 * of what was asked for, without either.
 *
 * Pure, so the format — which three different calendar apps have to accept —
 * is pinned by tests rather than by trying it in each of them.
 *
 * What goes in is what the person subscribing could see on the Schedule page:
 * the title, the client, the address, the crew. No amounts. A feed URL ends up
 * in another company's calendar service, so it carries the schedule and
 * nothing the schedule does not need.
 */

export type FeedEntry = {
  id: string;
  number: string;
  title: string;
  /** "Meeting", or a business's own category; null for a plain job. */
  kindLabel: string | null;
  status: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
  estimatedMinutes: number | null;
  description: string | null;
  clientName: string | null;
  address: string | null;
  crew: string[];
  updatedAt: Date;
  /** Where the entry opens in Matlock One. */
  url: string;
};

export type FeedOptions = {
  /** What the calendar is called in the subscriber's list. */
  name: string;
  /** The business's zone: which day an all-day entry falls on. */
  timeZone: string;
  /** Stamped on every event; passed in so the output is reproducible. */
  now: Date;
  /** Suffix of every UID, so ids stay unique across everybody's calendars. */
  domain: string;
};

const DEFAULT_MINUTES = 60;

/** What a description says, at most, before it is cut. */
const DESCRIPTION_LIMIT = 1000;

/**
 * Escapes a TEXT value (RFC 5545 §3.3.11). Backslash first, or the escapes
 * added for the others would be escaped again.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Folds a content line at 75 octets (RFC 5545 §3.1): the break is CRLF and
 * one space, and the count is in UTF-8 bytes, never splitting a character —
 * an accented client name cut mid-character comes out as garbage in Outlook.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  // The first line may hold 75 octets; each continuation spends one on the
  // leading space.
  let limit = 75;

  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);

  return parts.join("\r\n ");
}

/** 20261001T143000Z */
export function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function entryEnd(entry: FeedEntry): Date {
  if (entry.end && entry.end > entry.start) return entry.end;
  const minutes = entry.estimatedMinutes && entry.estimatedMinutes > 0
    ? entry.estimatedMinutes
    : DEFAULT_MINUTES;
  return new Date(entry.start.getTime() + minutes * 60_000);
}

/**
 * The DTSTART and DTEND lines.
 *
 * An all-day entry is dated on the business's calendar, and its DTEND is the
 * day after it ends: iCalendar's end is exclusive, so a one-day entry that
 * ended on its own day would be zero days long and some apps drop it.
 */
function whenLines(entry: FeedEntry, timeZone: string): string[] {
  if (!entry.allDay) {
    return [
      `DTSTART:${utcStamp(entry.start)}`,
      `DTEND:${utcStamp(entryEnd(entry))}`,
    ];
  }

  const lastDay = entry.end && entry.end > entry.start ? entry.end : entry.start;
  const firstDay = formatIn(entry.start, "yyyyMMdd", timeZone);
  const dayAfter = formatIn(addDays(inZone(lastDay, timeZone), 1), "yyyyMMdd", timeZone);

  return [`DTSTART;VALUE=DATE:${firstDay}`, `DTEND;VALUE=DATE:${dayAfter}`];
}

function summaryOf(entry: FeedEntry): string {
  return entry.clientName ? `${entry.title} · ${entry.clientName}` : entry.title;
}

function descriptionOf(entry: FeedEntry): string {
  const lines = [
    [entry.number, entry.kindLabel].filter(Boolean).join(" · "),
  ];
  if (entry.crew.length) lines.push(`Crew: ${entry.crew.join(", ")}`);

  const notes = entry.description?.trim();
  if (notes) {
    lines.push(
      "",
      notes.length > DESCRIPTION_LIMIT
        ? `${notes.slice(0, DESCRIPTION_LIMIT).trimEnd()}…`
        : notes,
    );
  }

  lines.push("", `Open in Matlock One: ${entry.url}`);
  return lines.join("\n");
}

function eventLines(entry: FeedEntry, options: FeedOptions): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${entry.id}@${options.domain}`,
    `DTSTAMP:${utcStamp(options.now)}`,
    `LAST-MODIFIED:${utcStamp(entry.updatedAt)}`,
    ...whenLines(entry, options.timeZone),
    `SUMMARY:${escapeText(summaryOf(entry))}`,
  ];

  if (entry.address) lines.push(`LOCATION:${escapeText(entry.address)}`);
  lines.push(`DESCRIPTION:${escapeText(descriptionOf(entry))}`);
  lines.push(`URL:${entry.url}`);
  // Busy or not, by what the entry is: a deadline marks a day without filling
  // it, so it should not show the subscriber as unavailable.
  lines.push(`TRANSP:${entry.allDay ? "TRANSPARENT" : "OPAQUE"}`);
  lines.push("END:VEVENT");

  return lines;
}

/**
 * The whole file. Cancelled entries are left out rather than sent as
 * STATUS:CANCELLED, which Google shows struck through in some views and not
 * at all in others; leaving them out reads the same everywhere.
 */
export function buildCalendarFeed(entries: FeedEntry[], options: FeedOptions): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Matlock One//Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(options.name)}`,
    `X-WR-TIMEZONE:${options.timeZone}`,
    // A hint, which Apple and Outlook honour and Google does not: Google
    // refreshes a subscribed calendar on its own timetable, every few hours.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const entry of entries) {
    if (entry.status === "CANCELLED") continue;
    lines.push(...eventLines(entry, options));
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** One line of address, the way a map app wants it. */
export function addressLine(address: {
  line1: string | null;
  line2?: string | null;
  city: string | null;
  state?: string | null;
  postalCode?: string | null;
} | null): string | null {
  if (!address) return null;
  const region = [address.state, address.postalCode].filter(Boolean).join(" ");
  const parts = [address.line1, address.line2, address.city, region].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return parts.length ? parts.join(", ") : null;
}

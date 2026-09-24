/**
 * The parts of team messaging that both the server and the browser need.
 *
 * No database here and no `server-only`: the thread is a client component, and
 * it has to agree with the server about limits, shapes and — above all — what
 * time it is.
 */

/** Long enough for directions to a site and a list of parts; not an essay. */
export const MESSAGE_MAX_LENGTH = 4000;
export const GROUP_TITLE_MAX_LENGTH = 80;
/** How many messages a thread opens on, and how many "earlier" loads at once. */
export const THREAD_PAGE_SIZE = 50;
/** Photos in one message: a walk-round of a job, not the whole camera roll. */
export const MAX_PHOTOS_PER_MESSAGE = 6;

/**
 * Raised on `window` when the sidebar's poll finds the unread count has moved,
 * so an open inbox can re-render with whatever arrived.
 */
export const UNREAD_CHANGED_EVENT = "matlock:unread-messages";

export type MessageView = {
  id: string;
  /** Empty when the message is only photos. */
  body: string;
  /** ISO string, because this crosses into client components and JSON alike. */
  createdAt: string;
  author: { id: string; name: string; avatarUrl: string | null } | null;
  /** Job photos this message carried, served by /api/files/[id]. */
  photos: { id: string; name: string }[];
};

/** Oldest first, and by id when two land in the same millisecond. */
export function mergeMessages(a: MessageView[], b: MessageView[]) {
  const byId = new Map<string, MessageView>();
  for (const message of a) byId.set(message.id, message);
  for (const message of b) byId.set(message.id, message);

  return [...byId.values()].sort((x, y) =>
    x.createdAt === y.createdAt
      ? x.id.localeCompare(y.id)
      : x.createdAt < y.createdAt
        ? -1
        : 1,
  );
}

// -------------------------------------------------------------------- time ---

/*
 * Every stamp is formatted in the business's own time zone rather than the
 * machine's, for two reasons. The hosted app renders on servers that run in
 * UTC, which would put a message sent at 2pm in North Carolina at "6:00 PM".
 * And the server and the browser must produce the same characters, or React
 * throws away the server's HTML on hydration.
 */

const LOCALE = "en-US";

/** The zone if this runtime knows it, otherwise the runtime's own. */
export function usableTimeZone(timeZone: string | null | undefined) {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/**
 * Newer ICU builds put a narrow no-break space before "PM". Node and the
 * browser do not always ship the same ICU, so one of them writing U+202F and
 * the other a plain space is a hydration mismatch over an invisible character.
 */
function plain(text: string) {
  return text.replace(/[  ]/g, " ");
}

function dayParts(date: Date, timeZone: string | undefined) {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** "2026-09-23" in the given zone: the key messages are grouped by. */
export function dayKey(date: Date, timeZone?: string) {
  const { year, month, day } = dayParts(date, usableTimeZone(timeZone));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Whole calendar days from `date` to `now`, counted in the given zone. */
function daysAgo(date: Date, now: Date, timeZone: string | undefined) {
  const a = dayParts(date, timeZone);
  const b = dayParts(now, timeZone);
  const ms =
    Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}

/** "2:14 PM" */
export function timeOfDay(date: Date, timeZone?: string) {
  return plain(
    new Intl.DateTimeFormat(LOCALE, {
      timeZone: usableTimeZone(timeZone),
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
  );
}

/** The divider between days in a thread: "Today", "Yesterday", "Monday, September 21". */
export function dayHeading(date: Date, timeZone?: string, now = new Date()) {
  const zone = usableTimeZone(timeZone);
  const gap = daysAgo(date, now, zone);
  if (gap === 0) return "Today";
  if (gap === 1) return "Yesterday";

  const sameYear = dayParts(date, zone).year === dayParts(now, zone).year;
  return plain(
    new Intl.DateTimeFormat(LOCALE, {
      timeZone: zone,
      weekday: "long",
      month: "long",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    }).format(date),
  );
}

/** The stamp on an inbox row: a time today, a weekday this week, a date after. */
export function inboxStamp(date: Date, timeZone?: string, now = new Date()) {
  const zone = usableTimeZone(timeZone);
  const gap = daysAgo(date, now, zone);
  if (gap <= 0) return timeOfDay(date, zone);
  if (gap === 1) return "Yesterday";
  if (gap < 7) {
    return new Intl.DateTimeFormat(LOCALE, { timeZone: zone, weekday: "short" }).format(date);
  }

  const sameYear = dayParts(date, zone).year === dayParts(now, zone).year;
  return plain(
    new Intl.DateTimeFormat(LOCALE, {
      timeZone: zone,
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "2-digit" }),
    }).format(date),
  );
}

// ------------------------------------------------------------------- links ---

export type TextPart = { text: string; href?: string };

/**
 * Splits a message into plain text and web links.
 *
 * Only http and https are ever turned into a link, so nothing a teammate types
 * can become a `javascript:` URL. Trailing punctuation stays outside the link:
 * "the supplier's site is example.com/parts." should not send anybody to a
 * page ending in a full stop.
 */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const pattern = /\bhttps?:\/\/[^\s<>"]+/gi;
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    let url = match[0];
    const trailing = /[.,;:!?'")\]]+$/.exec(url);
    // Keep a closing bracket that closes one opened inside the URL, as on
    // Wikipedia-style addresses.
    if (trailing) {
      let cut = trailing[0];
      if (cut.startsWith(")") && url.includes("(")) cut = cut.slice(1);
      url = url.slice(0, url.length - cut.length);
    }

    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, href: url });
    last = start + url.length;
  }

  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

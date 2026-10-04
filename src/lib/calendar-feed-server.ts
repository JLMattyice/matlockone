import "server-only";

import { randomBytes } from "node:crypto";

import { entitlement } from "./billing/entitlement";
import { addressLine, buildCalendarFeed, type FeedEntry } from "./calendar-feed";
import { resolveAppUrl } from "./config";
import { asStatus, ROLES, type Role } from "./constants";
import { prisma } from "./db";
import { entryCategory } from "./job-categories";
import { can } from "./permissions";
import { overlapsWhere } from "./schedule-span";

/**
 * Turning a feed address into a calendar file, and making the addresses.
 *
 * The address is the whole credential: a calendar app fetches it with no
 * cookie and no password, so the token in it is 32 characters from a
 * cryptographic source and is checked against nothing else. Two feeds hang off
 * one token — a person's own work, and for somebody who may see it, the whole
 * business's — so turning the link off or replacing it cuts off both at once.
 */

/** 24 random bytes in base64url: 32 characters, 192 bits. */
export function newFeedToken(): string {
  return randomBytes(24).toString("base64url");
}

const FEED_PATH = /^([A-Za-z0-9_-]{32})(-all)?\.ics$/;

/**
 * Reads "<token>.ics" or "<token>-all.ics". The scope lives in the file name
 * rather than a query string, which a calendar app is free to strip.
 */
export function parseFeedPath(segment: string): { token: string; all: boolean } | null {
  const match = FEED_PATH.exec(segment);
  return match ? { token: match[1], all: Boolean(match[2]) } : null;
}

export function feedAddresses(token: string) {
  const base = resolveAppUrl();
  const mine = `${base}/api/calendar/${token}.ics`;
  const all = `${base}/api/calendar/${token}-all.ics`;

  return { mine, all };
}

/** Past entries kept in the feed, so last week still shows on the phone. */
const DAYS_BACK = 60;
/** How far ahead it reaches: far enough for a recurring series to show. */
const DAYS_AHEAD = 400;
/** A ceiling on one fetch, whatever the business has booked. */
const MAX_ENTRIES = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type FeedResult =
  | { kind: "missing" }
  | { kind: "locked" }
  | { kind: "ok"; body: string; name: string };

/**
 * The calendar file for a token, or why there is none.
 *
 * "missing" covers a token nobody holds and a person who has been
 * deactivated; the route answers both the same way, so a removed employee's
 * calendar simply stops updating. "locked" is a business whose subscription
 * has lapsed, which gets its schedule back the moment it pays.
 *
 * Asking for the whole business without the right to see it is answered with
 * the person's own work, not refused: the likeliest way there is a manager
 * moved to employee after subscribing, and their own jobs are still theirs.
 */
export async function loadFeed(
  token: string,
  wantsAll: boolean,
  now: Date = new Date(),
): Promise<FeedResult> {
  const user = await prisma.user.findUnique({
    where: { calendarFeedToken: token },
    include: { organization: true },
  });
  if (!user || !user.isActive) return { kind: "missing" };

  const org = user.organization;
  if (!entitlement(org, now).ok) return { kind: "locked" };

  const actor = { id: user.id, role: asStatus(ROLES, user.role, "EMPLOYEE") as Role };
  const everything = wantsAll && can(actor, "jobs:read:all");

  const jobs = await prisma.job.findMany({
    where: {
      organizationId: org.id,
      status: { not: "CANCELLED" },
      // Overlapping the window, so a job over several days that began before
      // it is still there.
      ...overlapsWhere(
        new Date(now.getTime() - DAYS_BACK * DAY_MS),
        new Date(now.getTime() + DAYS_AHEAD * DAY_MS),
      ),
      ...(everything ? {} : { assignments: { some: { userId: user.id } } }),
    },
    orderBy: { scheduledStart: "asc" },
    take: MAX_ENTRIES,
    include: {
      client: { select: { displayName: true } },
      address: {
        select: { line1: true, line2: true, city: true, state: true, postalCode: true },
      },
      category: { select: { name: true, icon: true } },
      assignments: { select: { user: { select: { name: true } } } },
    },
  });

  const base = resolveAppUrl();
  const entries: FeedEntry[] = jobs.map((job) => {
    const mark = entryCategory(job, org.labelJobSingular);
    return {
      id: job.id,
      number: job.number,
      title: job.title,
      kindLabel: mark.plain ? null : mark.label,
      status: job.status,
      start: job.scheduledStart!,
      end: job.scheduledEnd,
      allDay: job.allDay,
      estimatedMinutes: job.estimatedMinutes,
      description: job.description,
      clientName: job.client?.displayName ?? null,
      address: addressLine(job.address),
      crew: job.assignments.map((assignment) => assignment.user.name),
      updatedAt: job.updatedAt,
      url: `${base}/jobs/${job.id}`,
    };
  });

  const name = everything ? org.name : `${org.name} · ${user.name}`;

  return {
    kind: "ok",
    name,
    body: buildCalendarFeed(entries, {
      name,
      timeZone: org.timeZone,
      now,
      domain: new URL(base).host,
    }),
  };
}

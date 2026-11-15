import "server-only";

import { prisma } from "@/lib/db";
import { jobVisibilityWhere, type Actor } from "@/lib/permissions";
import { overlapsWhere } from "@/lib/schedule-span";
import { clockMinutes, openClock, runningTimer } from "@/lib/time-clock";
import { formatIn, parseDateTimeLocal } from "@/lib/time-zone";

const DAY = 24 * 60 * 60 * 1000;

/** Midnight to midnight on the viewer's clock, whatever the daylight saving. */
export function dayBounds(now: Date, zone: string) {
  const today = formatIn(now, "yyyy-MM-dd", zone);
  const start = parseDateTimeLocal(`${today}T00:00`, zone)!;
  const tomorrow = formatIn(new Date(start.getTime() + DAY + 2 * 60 * 60 * 1000), "yyyy-MM-dd", zone);
  return { start, end: parseDateTimeLocal(`${tomorrow}T00:00`, zone)! };
}

const VISIT_SELECT = {
  id: true,
  number: true,
  title: true,
  status: true,
  scheduledStart: true,
  scheduledEnd: true,
  allDay: true,
  client: { select: { displayName: true, phone: true } },
  address: { select: { line1: true, line2: true, city: true, state: true, postalCode: true } },
  checklistItems: { select: { doneAt: true } },
} as const;

/**
 * Everything one person's day needs: their visits today, work of theirs still
 * open from before, the clock, and the timer.
 */
export async function myDay(organizationId: string, userId: string, zone: string, now = new Date()) {
  const { start, end } = dayBounds(now, zone);
  const mine = { assignments: { some: { userId } } };
  const who = { organizationId, userId };

  const [today, carriedOver, clock, timer, clockedToday] = await Promise.all([
    prisma.job.findMany({
      where: {
        organizationId,
        ...mine,
        status: { not: "CANCELLED" },
        // Today's visits, and today's part of one over several days.
        ...overlapsWhere(start, new Date(end.getTime() - 1)),
      },
      orderBy: [{ allDay: "desc" }, { scheduledStart: "asc" }],
      select: VISIT_SELECT,
    }),
    // Started on an earlier day and never finished: still theirs to close.
    prisma.job.findMany({
      where: {
        organizationId,
        ...mine,
        status: "IN_PROGRESS",
        OR: [{ scheduledStart: { lt: start } }, { scheduledStart: null }],
      },
      orderBy: { scheduledStart: "asc" },
      take: 20,
      select: VISIT_SELECT,
    }),
    openClock(who),
    runningTimer(who),
    prisma.clockEntry.findMany({
      where: { organizationId, userId, clockedInAt: { gte: start, lt: end } },
      select: { clockedInAt: true, clockedOutAt: true },
    }),
  ]);

  const visit = (job: (typeof today)[number]) => ({
    ...job,
    checklist: {
      total: job.checklistItems.length,
      done: job.checklistItems.filter((item) => item.doneAt).length,
    },
  });

  // A job over several days that is under way is today's, not carried over.
  const onToday = new Set(today.map((job) => job.id));

  return {
    today: today.map(visit),
    carriedOver: carriedOver.filter((job) => !onToday.has(job.id)).map(visit),
    clock,
    /** The open entry began on an earlier day: they forgot to clock out. */
    clockFromEarlier: Boolean(clock && clock.clockedInAt < start),
    timer,
    minutesToday: clockedToday.reduce((sum, entry) => sum + clockMinutes(entry, now), 0),
  };
}

export type MyDay = Awaited<ReturnType<typeof myDay>>;
export type Visit = MyDay["today"][number];

export type JobChoice = { id: string; label: string };
export type JobChoiceGroup = { label: string; jobs: JobChoice[] };

/** Statuses a job is still open in: work can be done on it and timed. */
const OPEN = ["SCHEDULED", "CONFIRMED", "IN_PROGRESS"];

const CHOICE_SELECT = {
  id: true,
  number: true,
  title: true,
  scheduledStart: true,
  client: { select: { displayName: true } },
} as const;

/**
 * What the clock offers to put time on: any open job this person can see,
 * nearest first — today's, what is coming, what is still open from before,
 * and what was never booked. An employee sees their own jobs, as everywhere.
 *
 * Bounded on purpose. A repeating visit is sixty real jobs made up front, so
 * "every open job" can be a year of them; a job too far out to be offered
 * here is timed from its own page instead.
 */
export async function jobChoices(
  organizationId: string,
  actor: Actor,
  zone: string,
  now = new Date(),
): Promise<JobChoiceGroup[]> {
  const { start, end } = dayBounds(now, zone);
  const open = { organizationId, status: { in: OPEN }, ...jobVisibilityWhere(actor) };

  const [today, coming, before, unbooked] = await Promise.all([
    prisma.job.findMany({
      where: { ...open, ...overlapsWhere(start, new Date(end.getTime() - 1)) },
      orderBy: [{ allDay: "desc" }, { scheduledStart: "asc" }],
      take: 100,
      select: CHOICE_SELECT,
    }),
    prisma.job.findMany({
      where: { ...open, scheduledStart: { gte: end } },
      orderBy: { scheduledStart: "asc" },
      take: 40,
      select: CHOICE_SELECT,
    }),
    prisma.job.findMany({
      where: { ...open, scheduledStart: { lt: start } },
      orderBy: { scheduledStart: "desc" },
      take: 60,
      select: CHOICE_SELECT,
    }),
    prisma.job.findMany({
      where: { ...open, scheduledStart: null },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: CHOICE_SELECT,
    }),
  ]);

  // A job over several days began before today and is on today's list too.
  const onToday = new Set(today.map((job) => job.id));

  const choice = (dated: boolean) => (job: (typeof today)[number]) => ({
    id: job.id,
    label:
      `${job.number} · ${job.title}` +
      (job.client ? ` — ${job.client.displayName}` : "") +
      // The date tells apart the visits of a repeat, which share a title.
      (dated && job.scheduledStart ? ` (${formatIn(job.scheduledStart, "MMM d", zone)})` : ""),
  });

  return [
    { label: "Today", jobs: today.map(choice(false)) },
    { label: "Coming up", jobs: coming.map(choice(true)) },
    { label: "Still open from before", jobs: before.filter((job) => !onToday.has(job.id)).map(choice(true)) },
    { label: "Not booked yet", jobs: unbooked.map(choice(false)) },
  ].filter((group) => group.jobs.length > 0);
}

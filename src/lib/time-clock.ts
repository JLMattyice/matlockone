import "server-only";

import { prisma } from "./db";

/**
 * The day clock and the job timer.
 *
 * Two different questions, kept apart as the owner asked for both: the clock
 * says when somebody started and stopped work for the day; the timer says
 * which job the time in between went on. A running timer is an ordinary time
 * entry with no end yet, so labour costs, reports and the job's own Labor
 * card already know what to do with it once it stops.
 *
 * The rules: one open clock entry and one running timer per person. Starting
 * a timer clocks you in if you were not; clocking out stops the timer. No
 * location is recorded anywhere, by the owner's choice.
 */

const MINUTE = 60_000;
/** The most one timer can count: a phone left running over a weekend is not 60 hours on a job. */
export const TIMER_MAX_MINUTES = 12 * 60;

type Who = { organizationId: string; userId: string };

export async function openClock({ organizationId, userId }: Who) {
  return prisma.clockEntry.findFirst({
    where: { organizationId, userId, clockedOutAt: null },
    orderBy: { clockedInAt: "desc" },
    select: { id: true, clockedInAt: true },
  });
}

export async function runningTimer({ organizationId, userId }: Who) {
  return prisma.timeEntry.findFirst({
    where: { organizationId, userId, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true, job: { select: { id: true, number: true, title: true } } },
  });
}

/** Clocks in, or leaves an open entry as it is. */
export async function clockIn(who: Who, at = new Date()) {
  const open = await openClock(who);
  if (open) return open;
  return prisma.clockEntry.create({
    data: { organizationId: who.organizationId, userId: who.userId, clockedInAt: at },
    select: { id: true, clockedInAt: true },
  });
}

/**
 * Clocks out — at `at`, which may be earlier than now for somebody who forgot
 * — and stops a running timer with it. Every open entry is closed, so two
 * taps that raced each other in leave nothing behind.
 */
export async function clockOut(who: Who, at = new Date()) {
  await stopTimer(who, at);
  const open = await prisma.clockEntry.findMany({
    where: { organizationId: who.organizationId, userId: who.userId, clockedOutAt: null },
    select: { id: true, clockedInAt: true },
  });
  for (const entry of open) {
    await prisma.clockEntry.update({
      where: { id: entry.id },
      // Never before it began, whatever time was typed.
      data: { clockedOutAt: at > entry.clockedInAt ? at : entry.clockedInAt },
    });
  }
  return open.length;
}

/** Starts the timer on a job, stopping any other and clocking in first. */
export async function startTimer(who: Who, jobId: string, at = new Date()) {
  const running = await runningTimer(who);
  if (running?.job.id === jobId) return running.id;

  await stopTimer(who, at);
  await clockIn(who, at);

  const person = await prisma.user.findUniqueOrThrow({
    where: { id: who.userId },
    select: { hourlyRateCents: true },
  });
  const entry = await prisma.timeEntry.create({
    data: {
      organizationId: who.organizationId,
      jobId,
      userId: who.userId,
      startedAt: at,
      endedAt: null,
      minutes: 0,
      // The rate as it stands, as a logged entry snapshots it.
      hourlyRateCents: person.hourlyRateCents ?? 0,
      billable: true,
    },
    select: { id: true },
  });
  return entry.id;
}

/** Stops whatever timer is running. Returns the minutes it counted. */
export async function stopTimer(who: Who, at = new Date()) {
  const running = await prisma.timeEntry.findMany({
    where: { organizationId: who.organizationId, userId: who.userId, endedAt: null },
    select: { id: true, startedAt: true },
  });
  let counted = 0;
  for (const entry of running) {
    const minutes = Math.min(
      TIMER_MAX_MINUTES,
      Math.max(1, Math.round((at.getTime() - entry.startedAt.getTime()) / MINUTE)),
    );
    await prisma.timeEntry.update({
      where: { id: entry.id },
      data: { endedAt: new Date(entry.startedAt.getTime() + minutes * MINUTE), minutes },
    });
    counted += minutes;
  }
  return counted;
}

/** Minutes between two times, or up to now for an open entry. */
export function clockMinutes(entry: { clockedInAt: Date; clockedOutAt: Date | null }, now = new Date()) {
  const end = entry.clockedOutAt ?? now;
  return Math.max(0, Math.round((end.getTime() - entry.clockedInAt.getTime()) / MINUTE));
}

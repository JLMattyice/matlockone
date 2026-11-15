"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { stopTimer } from "@/lib/time-clock";
import { formatIn, parseDateTimeLocal } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

/**
 * Fixing the day clock: somebody forgot to clock out, clocked in from the
 * truck an hour late, or never clocked in at all. Whoever runs the crews'
 * schedule (jobs:assign) may correct the times or enter a stretch by hand;
 * the entry then says who did.
 *
 * Two stretches of one person's never overlap — the same hour would be paid
 * twice — so a correction that runs into another of theirs is refused.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Everywhere the stretch shows: the team's page, its owner's sheet, and their own day. */
function refresh(userId?: string) {
  revalidatePath("/team/time-clock");
  if (userId) revalidatePath(`/team/time-clock/${userId}`);
  revalidatePath("/my-day");
  revalidatePath("/my-day/hours");
}

type Times = { clockedInAt: Date; clockedOutAt: Date | null };

/**
 * Reads the two times off the form. `mustEnd` is for an entry that was
 * already closed: it cannot be put back on the clock by emptying a box.
 */
function readTimes(
  formData: FormData,
  zone: string,
  mustEnd: boolean,
): Times | { fieldErrors: Record<string, string> } {
  const clockedInAt = parseDateTimeLocal(text(formData, "in"), zone);
  const outText = text(formData, "out");
  const clockedOutAt = outText ? parseDateTimeLocal(outText, zone) : null;
  const now = new Date();

  if (!clockedInAt) return { fieldErrors: { in: "Pick when they started." } };
  if (outText && !clockedOutAt) return { fieldErrors: { out: "Pick when they stopped." } };
  if (clockedInAt > now) return { fieldErrors: { in: "That is still to come." } };
  if (!clockedOutAt && mustEnd) return { fieldErrors: { out: "Pick when they stopped." } };
  if (clockedOutAt) {
    if (clockedOutAt > now) return { fieldErrors: { out: "That is still to come." } };
    if (clockedOutAt <= clockedInAt) return { fieldErrors: { out: "That is before they started." } };
    if (clockedOutAt.getTime() - clockedInAt.getTime() > DAY) {
      return { fieldErrors: { out: "One entry covers a day at most. Add the next day separately." } };
    }
  }
  return { clockedInAt, clockedOutAt };
}

/**
 * Another stretch of this person's that these times would run into, said the
 * way the form can show it — or null when the times are clear. A stretch
 * with no end is still running, so it reaches as far as now does.
 */
async function overlapWith(
  who: { organizationId: string; userId: string },
  times: Times,
  zone: string,
  exceptId?: string,
) {
  const other = await prisma.clockEntry.findFirst({
    where: {
      ...who,
      ...(exceptId ? { id: { not: exceptId } } : {}),
      ...(times.clockedOutAt ? { clockedInAt: { lt: times.clockedOutAt } } : {}),
      OR: [{ clockedOutAt: null }, { clockedOutAt: { gt: times.clockedInAt } }],
    },
    orderBy: { clockedInAt: "asc" },
    select: { clockedInAt: true, clockedOutAt: true },
  });
  if (!other) return null;

  const from = formatIn(other.clockedInAt, "EEE, MMM d 'at' h:mm a", zone);
  return other.clockedOutAt
    ? `That runs into their entry from ${from} to ${formatIn(other.clockedOutAt, "h:mm a", zone)}.`
    : `That runs into the entry they are still clocked in on, from ${from}.`;
}

export async function fixClockEntry(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:assign");

  const entry = await prisma.clockEntry.findFirst({
    where: { id: String(formData.get("id") ?? ""), organizationId: org.id },
    select: { id: true, userId: true, clockedOutAt: true },
  });
  if (!entry) return failed("That entry was deleted. Refresh to see the week as it is now.");

  const zone = await viewerTimeZone();
  const times = readTimes(formData, zone, Boolean(entry.clockedOutAt));
  if ("fieldErrors" in times) return { ok: false, fieldErrors: times.fieldErrors };

  const who = { organizationId: org.id, userId: entry.userId };
  const overlap = await overlapWith(who, times, zone, entry.id);
  if (overlap) return failed(overlap);

  await prisma.clockEntry.update({
    where: { id: entry.id },
    data: { ...times, editedById: user.id },
  });
  // Closing a stretch for somebody is clocking them out, and clocking out
  // stops the timer: one left running would count up to its cap on the job.
  if (!entry.clockedOutAt && times.clockedOutAt) await stopTimer(who, times.clockedOutAt);

  refresh(entry.userId);
  return saved("Saved.");
}

/**
 * Enters a stretch nobody clocked: a day somebody forgot the clock entirely,
 * or — with no end — somebody working now who never clocked in.
 */
export async function addClockEntry(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:assign");

  const person = await prisma.user.findFirst({
    where: { id: String(formData.get("userId") ?? ""), organizationId: org.id },
    select: { id: true },
  });
  if (!person) return { ok: false, fieldErrors: { userId: "Pick who it is for." } };

  const zone = await viewerTimeZone();
  const times = readTimes(formData, zone, false);
  if ("fieldErrors" in times) return { ok: false, fieldErrors: times.fieldErrors };

  const overlap = await overlapWith({ organizationId: org.id, userId: person.id }, times, zone);
  if (overlap) return failed(overlap);

  await prisma.clockEntry.create({
    data: { organizationId: org.id, userId: person.id, ...times, editedById: user.id },
  });
  refresh(person.id);
  return saved("Added.");
}

export async function deleteClockEntry(formData: FormData) {
  const { org } = await requirePermission("jobs:assign");
  const entry = await prisma.clockEntry.findFirst({
    where: { id: String(formData.get("id") ?? ""), organizationId: org.id },
    select: { id: true, userId: true },
  });
  if (entry) await prisma.clockEntry.deleteMany({ where: { id: entry.id, organizationId: org.id } });
  refresh(entry?.userId);
}

"use server";

import { revalidatePath } from "next/cache";

import { requireContext } from "@/lib/auth";
import { failed, saved, type ActionState } from "@/lib/action-state";
import { newFeedToken } from "@/lib/calendar-feed-server";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";

/**
 * Turning your own calendar feed on, replacing its address, and turning it
 * off. Each acts on the person signed in and nobody else: a feed carries one
 * person's schedule, so there is nothing here for a manager to do on somebody
 * else's behalf. Deactivating a team member already stops theirs.
 */

const PATH = "/settings/profile";

async function feedOwner() {
  const { user } = await requireContext();
  return can(user, "schedule:read") ? user : null;
}

export async function turnOnCalendarFeed(_prev: ActionState): Promise<ActionState> {
  const user = await feedOwner();
  if (!user) return failed("You do not have a schedule to share.");

  // Only when there is none: pressing it twice must not quietly break the
  // link that was copied the first time.
  await prisma.user.updateMany({
    where: { id: user.id, calendarFeedToken: null },
    data: { calendarFeedToken: newFeedToken() },
  });

  revalidatePath(PATH);
  return saved("Calendar link ready.");
}

export async function resetCalendarFeed(_prev: ActionState): Promise<ActionState> {
  const user = await feedOwner();
  if (!user) return failed("You do not have a schedule to share.");

  await prisma.user.update({
    where: { id: user.id },
    data: { calendarFeedToken: newFeedToken() },
  });

  revalidatePath(PATH);
  return saved("New link made. The old one has stopped working.");
}

export async function turnOffCalendarFeed(_prev: ActionState): Promise<ActionState> {
  const user = await feedOwner();
  if (!user) return failed("You do not have a schedule to share.");

  await prisma.user.update({
    where: { id: user.id },
    data: { calendarFeedToken: null },
  });

  revalidatePath(PATH);
  return saved("Calendar link turned off.");
}

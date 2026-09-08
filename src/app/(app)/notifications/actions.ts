"use server";

import { revalidatePath } from "next/cache";

import { requireContext } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * Notifications belong to one person, so every action here is scoped by
 * `userId` as well as organization — a valid id from a colleague's bell must
 * not be markable by someone else.
 */

export async function markNotificationRead(formData: FormData) {
  const { user } = await requireContext();

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await prisma.notification.updateMany({
    where: { id, userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });

  revalidatePath("/", "layout");
}

export async function markAllNotificationsRead() {
  const { user } = await requireContext();

  await prisma.notification.updateMany({
    where: { userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });

  revalidatePath("/", "layout");
}

export async function clearReadNotifications() {
  const { user } = await requireContext();

  await prisma.notification.deleteMany({
    where: { userId: user.id, readAt: { not: null } },
  });

  revalidatePath("/notifications");
  revalidatePath("/", "layout");
}

import "server-only";

import type { NotificationType } from "./constants";
import { prisma } from "./db";
import { sendMessage } from "./messaging";

/**
 * In-app notifications, with email as an optional second channel.
 *
 * Everything lands in the `Notification` table so it shows in the bell menu.
 * When `email` is supplied the same message also goes through the outbox, which
 * is stubbed by default — so a demo produces a full, readable notification
 * trail without sending anything.
 *
 * Notifying is deliberately best-effort: a failure here must not roll back the
 * job assignment or payment that triggered it.
 */

export type NotifyInput = {
  organizationId: string;
  /** Recipients. Duplicates and the actor themselves are filtered out. */
  userIds: string[];
  type: NotificationType;
  title: string;
  body?: string | null;
  entityType?: string;
  entityId?: string;
  actionUrl?: string;
  /** Skip notifying the person who caused the event. */
  exceptUserId?: string;
};

export async function notify(input: NotifyInput) {
  const recipients = [...new Set(input.userIds)].filter(
    (id) => id && id !== input.exceptUserId,
  );
  if (recipients.length === 0) return;

  try {
    await prisma.notification.createMany({
      data: recipients.map((userId) => ({
        organizationId: input.organizationId,
        userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        actionUrl: input.actionUrl ?? null,
      })),
    });
  } catch (error) {
    console.error("Failed to write notifications", error);
  }
}

/** A client-facing confirmation, sent through the outbox. */
export async function notifyClientByEmail(input: {
  organizationId: string;
  to: string | null | undefined;
  toName: string;
  subject: string;
  body: string;
  relatedType?: string;
  relatedId?: string;
  createdById?: string | null;
}) {
  if (!input.to) return;

  try {
    await sendMessage({
      organizationId: input.organizationId,
      channel: "EMAIL",
      to: input.to,
      toName: input.toName,
      subject: input.subject,
      body: input.body,
      relatedType: input.relatedType,
      relatedId: input.relatedId,
      createdById: input.createdById ?? null,
    });
  } catch (error) {
    console.error("Failed to queue client email", error);
  }
}

export async function unreadNotificationCount(userId: string) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function recentNotifications(userId: string, take = 8) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

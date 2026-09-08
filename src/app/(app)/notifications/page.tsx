import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { Bell, Check } from "lucide-react";

import { clearReadNotifications, markAllNotificationsRead } from "./actions";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { requireContext } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Notifications" };

const TYPE_LABELS: Record<string, string> = {
  JOB_ASSIGNED: "Assignment",
  JOB_REMINDER: "Reminder",
  APPOINTMENT_REMINDER: "Reminder",
  SCHEDULE_CHANGE: "Schedule change",
  INVOICE_DUE: "Invoice due",
  INVOICE_OVERDUE: "Overdue",
  PAYMENT_RECEIVED: "Payment",
};

export default async function NotificationsPage() {
  const { user } = await requireContext();

  const notifications = await prisma.notification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const unread = notifications.filter((n) => !n.readAt).length;
  const read = notifications.length - unread;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description={
          unread > 0 ? `${unread} unread` : "You are all caught up"
        }
        actions={
          <>
            {unread > 0 ? (
              <form action={markAllNotificationsRead}>
                <button type="submit" className={buttonClasses("outline", "md")}>
                  <Check className="h-3.5 w-3.5" strokeWidth={2} />
                  Mark all read
                </button>
              </form>
            ) : null}
            {read > 0 ? (
              <form action={clearReadNotifications}>
                <button type="submit" className={buttonClasses("ghost", "md")}>
                  Clear read
                </button>
              </form>
            ) : null}
          </>
        }
      />

      <Card className="overflow-hidden">
        {notifications.length === 0 ? (
          <EmptyState
            icon={<Bell className="h-5 w-5" strokeWidth={1.75} />}
            title="No notifications"
            description="Assignments, schedule changes and payments show up here."
          />
        ) : (
          <ul className="divide-y divide-line">
            {notifications.map((notification) => {
              const body = (
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                      notification.readAt ? "bg-transparent" : "bg-brand",
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p
                        className={cn(
                          "text-sm",
                          notification.readAt
                            ? "text-ink-muted"
                            : "font-medium text-ink",
                        )}
                      >
                        {notification.title}
                      </p>
                      <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[0.6875rem] text-ink-subtle">
                        {TYPE_LABELS[notification.type] ?? notification.type}
                      </span>
                    </div>
                    {notification.body ? (
                      <p className="mt-0.5 text-sm text-ink-muted">
                        {notification.body}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-ink-subtle">
                      {format(notification.createdAt, "MMM d, yyyy 'at' h:mm a")}
                    </p>
                  </div>
                </div>
              );

              return (
                <li key={notification.id}>
                  {notification.actionUrl ? (
                    <Link
                      href={notification.actionUrl}
                      className="block px-5 py-3.5 transition-colors hover:bg-surface-2"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="px-5 py-3.5">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

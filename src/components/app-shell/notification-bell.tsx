"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Bell, Check } from "lucide-react";

import { markAllNotificationsRead } from "@/app/(app)/notifications/actions";
import { cn } from "@/lib/utils";

export type BellNotification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  actionUrl: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export function NotificationBell({
  notifications,
  unreadCount,
}: {
  notifications: BellNotification[];
  unreadCount: number;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          unreadCount > 0
            ? `Notifications, ${unreadCount} unread`
            : "Notifications"
        }
        className="relative flex h-8.5 w-8.5 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
      >
        <Bell className="h-4.5 w-4.5" strokeWidth={1.75} />
        {unreadCount > 0 ? (
          <span className="tabular absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[0.625rem] font-semibold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-80 overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <p className="text-sm font-semibold text-ink">Notifications</p>
            {unreadCount > 0 ? (
              <form action={markAllNotificationsRead}>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
                >
                  <Check className="h-3 w-3" strokeWidth={2.5} />
                  Mark all read
                </button>
              </form>
            ) : null}
          </div>

          {notifications.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-sm text-ink-subtle">
              Nothing yet.
            </p>
          ) : (
            <ul className="scrollbar-thin max-h-96 divide-y divide-line overflow-y-auto">
              {notifications.map((notification) => {
                const content = (
                  <>
                    <div className="flex items-start gap-2">
                      {!notification.readAt ? (
                        <span
                          className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
                          aria-hidden
                        />
                      ) : (
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0" aria-hidden />
                      )}
                      <div className="min-w-0">
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
                        {notification.body ? (
                          <p className="truncate text-xs text-ink-subtle">
                            {notification.body}
                          </p>
                        ) : null}
                        <p className="mt-0.5 text-[0.6875rem] text-ink-subtle">
                          {formatDistanceToNow(notification.createdAt)} ago
                        </p>
                      </div>
                    </div>
                  </>
                );

                return (
                  <li key={notification.id}>
                    {notification.actionUrl ? (
                      <Link
                        href={notification.actionUrl}
                        onClick={() => setOpen(false)}
                        className="block px-3.5 py-2.5 transition-colors hover:bg-surface-2"
                      >
                        {content}
                      </Link>
                    ) : (
                      <div className="px-3.5 py-2.5">{content}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-line px-3.5 py-2.5 text-center text-xs text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            See all notifications
          </Link>
        </div>
      ) : null}
    </div>
  );
}

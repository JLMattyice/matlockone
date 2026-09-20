import Link from "next/link";
import {
  Banknote,
  Briefcase,
  Check,
  Paperclip,
  Send,
  StickyNote,
  UserPlus,
  X,
} from "lucide-react";

import { EmptyState } from "@/components/ui/page-header";
import {
  activityHref,
  activityMeta,
  groupByDay,
  type ActivityEvent,
  type ActivityIcon,
  type ActivityTone,
} from "@/lib/activity";
import { cn } from "@/lib/utils";

/**
 * What happened, under the day it happened on.
 *
 * A server component: the sentences are already written and the grouping is
 * already done, so there is nothing here for the browser to work out.
 */

const ICONS: Record<ActivityIcon, typeof Check> = {
  user: UserPlus,
  briefcase: Briefcase,
  send: Send,
  check: Check,
  x: X,
  banknote: Banknote,
  note: StickyNote,
  paperclip: Paperclip,
};

const TONES: Record<ActivityTone, string> = {
  brand: "bg-brand/10 text-brand",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  neutral: "bg-surface-3 text-ink-muted",
};

export function ActivityTimeline({
  events,
  emptyTitle = "Nothing yet",
  emptyDescription = "Work, documents and payments will appear here as they happen.",
}: {
  events: ActivityEvent[];
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (events.length === 0) {
    return (
      <EmptyState
        icon={<StickyNote className="h-5 w-5" strokeWidth={1.75} />}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  const days = groupByDay(events);

  return (
    <div className="px-5 py-4">
      {days.map((day) => (
        <section key={day.label} className="mb-5 last:mb-0">
          <h3 className="mb-2.5 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
            {day.label}
          </h3>

          <ol className="space-y-0.5">
            {day.events.map((event) => (
              <Event key={event.id} event={event} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Event({ event }: { event: ActivityEvent }) {
  const meta = activityMeta(event.action);
  const Icon = ICONS[meta.icon];
  const href = activityHref(event.entityType, event.entityId);

  const body = (
    <>
      <span
        className={cn(
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          TONES[meta.tone],
        )}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink">{event.summary}</span>
        <span className="mt-0.5 block text-xs text-ink-subtle">
          {event.createdAt.toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}
          {event.actor ? ` · ${event.actor}` : ""}
        </span>
      </span>
    </>
  );

  return (
    <li>
      {href ? (
        <Link
          href={href}
          className="flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2"
        >
          {body}
        </Link>
      ) : (
        <div className="flex items-start gap-3 px-2 py-2">{body}</div>
      )}
    </li>
  );
}

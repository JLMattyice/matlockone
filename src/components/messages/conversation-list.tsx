"use client";

import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { MessageSquare, SquarePen } from "lucide-react";

import { ConversationAvatar } from "./conversation-avatar";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";
import { inboxStamp } from "@/lib/chat";
import type { InboxRow } from "@/lib/conversations";
import { cn } from "@/lib/utils";

/** Every thread the viewer is in, most recently active first. */
export function ConversationList({
  rows,
  timeZone,
}: {
  rows: InboxRow[];
  timeZone: string;
}) {
  const selected = useSelectedLayoutSegment();

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h1 className="text-base font-semibold tracking-tight text-ink">Messages</h1>
        <Link href="/messages/new" className={buttonClasses("primary", "sm")}>
          <SquarePen className="h-3.5 w-3.5" strokeWidth={2} />
          New
        </Link>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          className="flex-1"
          icon={<MessageSquare className="h-5 w-5" strokeWidth={1.75} />}
          title="No conversations yet"
          description="Message anyone on the team, or start a group for a crew."
        />
      ) : (
        <ul className="scrollbar-thin min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {rows.map((row) => (
            <ConversationRow
              key={row.id}
              row={row}
              active={row.id === selected}
              timeZone={timeZone}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function preview(row: InboxRow) {
  const last = row.lastMessage;
  if (!last) return "No messages yet";

  const photos =
    last.photoCount === 1 ? "Sent a photo" : `Sent ${last.photoCount} photos`;
  const body = last.body.replace(/\s+/g, " ") || (last.photoCount > 0 ? photos : "");
  if (last.mine) return `You: ${body}`;
  // In a direct thread the name on the row already says who wrote it.
  if (row.kind !== "DIRECT") {
    const first = last.authorName?.split(/\s+/)[0] ?? "Former teammate";
    return `${first}: ${body}`;
  }
  return body;
}

function ConversationRow({
  row,
  active,
  timeZone,
}: {
  row: InboxRow;
  active: boolean;
  timeZone: string;
}) {
  const unread = row.unread > 0;
  const stamp = inboxStamp(new Date(row.lastMessage?.createdAt ?? row.lastMessageAt), timeZone);

  return (
    <li>
      <Link
        href={`/messages/${row.id}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-3 px-4 py-3 transition-colors",
          active ? "bg-brand/10" : "hover:bg-surface-2",
        )}
      >
        <ConversationAvatar kind={row.kind} others={row.others} />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p
              className={cn(
                "truncate text-sm text-ink",
                unread ? "font-semibold" : "font-medium",
              )}
            >
              {row.title}
            </p>
            <span
              className={cn(
                "tabular shrink-0 text-[0.6875rem]",
                unread ? "font-medium text-brand" : "text-ink-subtle",
              )}
            >
              {stamp}
            </span>
          </div>

          <div className="mt-0.5 flex items-center justify-between gap-2">
            <p className={cn("truncate text-xs", unread ? "text-ink" : "text-ink-muted")}>
              {preview(row)}
            </p>
            {unread ? (
              <span className="tabular flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[0.625rem] font-semibold text-brand-ink">
                <span className="sr-only">Unread: </span>
                {row.unread > 99 ? "99+" : row.unread}
              </span>
            ) : null}
          </div>
        </div>
      </Link>
    </li>
  );
}

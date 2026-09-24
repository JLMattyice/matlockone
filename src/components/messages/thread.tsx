"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ArrowLeft, SendHorizontal } from "lucide-react";

import { ConversationAvatar } from "./conversation-avatar";
import { sendMessage } from "@/app/(app)/messages/actions";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/form";
import {
  dayHeading,
  dayKey,
  MESSAGE_MAX_LENGTH,
  mergeMessages,
  splitLinks,
  timeOfDay,
  type MessageView,
} from "@/lib/chat";
import type { ConversationDetail } from "@/lib/conversations";
import { cn } from "@/lib/utils";

/**
 * One open conversation.
 *
 * New messages arrive by polling every few seconds while the tab is visible,
 * and not at all while it is hidden — a phone in a pocket should not be
 * asking a server anything. Sending shows the message at once, faded, and
 * swaps in the saved one when the server answers; a failure puts the text
 * back in the box rather than losing it.
 */

const POLL_MS = 4000;
/** Consecutive messages from one person closer than this read as one block. */
const RUN_GAP_MS = 5 * 60 * 1000;
/** Close enough to the bottom that a new message should scroll into view. */
const NEAR_BOTTOM_PX = 120;
/** About six lines; past this the box scrolls instead of growing. */
const COMPOSER_MAX_PX = 160;

type Pending = { key: string; body: string };

type Item =
  | { type: "day"; key: string; label: string }
  | {
      type: "message";
      key: string;
      message: MessageView;
      startsRun: boolean;
      endsRun: boolean;
    };

export function Thread({
  conversation,
  viewerId,
  initialMessages,
  initialHasEarlier,
  timeZone,
}: {
  conversation: ConversationDetail;
  viewerId: string;
  initialMessages: MessageView[];
  initialHasEarlier: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [hasEarlier, setHasEarlier] = useState(initialHasEarlier);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const newestRef = useRef<string | null>(initialMessages.at(-1)?.createdAt ?? null);
  /** Whether to follow new messages down, i.e. the reader is at the bottom. */
  const followRef = useRef(true);
  /** Scroll height before older messages were put above, to hold position. */
  const prependedFromRef = useRef<number | null>(null);

  const isGroup = conversation.kind === "GROUP";
  const reachable = conversation.others.some((person) => person.isActive);
  const firstName = (name: string) => name.split(/\s+/)[0] || name;

  // A server refresh — after sending, or after a read moved the inbox —
  // brings the latest page again. Fold it in rather than replacing whatever
  // older history has been loaded above it.
  useEffect(() => {
    setMessages((current) => mergeMessages(current, initialMessages));
  }, [initialMessages]);

  useEffect(() => {
    newestRef.current = messages.at(-1)?.createdAt ?? null;
  }, [messages]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (prependedFromRef.current !== null) {
      el.scrollTop += el.scrollHeight - prependedFromRef.current;
      prependedFromRef.current = null;
      return;
    }
    if (followRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  // Grow the box with what is typed, up to a few lines, and only offer a
  // scrollbar once it has stopped growing.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight + (el.offsetHeight - el.clientHeight);
    el.style.height = `${Math.min(full, COMPOSER_MAX_PX)}px`;
    el.style.overflowY = full > COMPOSER_MAX_PX ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (stopped || busy) return;
      clearTimeout(timer);

      if (document.visibilityState === "visible") {
        busy = true;
        try {
          const after = newestRef.current;
          const response = await fetch(
            `/api/messages/${conversation.id}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
            { cache: "no-store" },
          );
          if (response.ok) {
            const data = (await response.json()) as {
              messages: MessageView[];
              markedRead: boolean;
            };
            if (!stopped && data.messages.length > 0) {
              setMessages((current) => mergeMessages(current, data.messages));
            }
            // The inbox and the sidebar badge are rendered on the server, so a
            // read that moved something is their cue to catch up.
            if (!stopped && data.markedRead) router.refresh();
          }
        } catch {
          // Offline for a moment — a van between towers. The next poll retries.
        } finally {
          busy = false;
        }
      }

      if (!stopped) timer = setTimeout(poll, POLL_MS);
    }

    void poll();

    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [conversation.id, router]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  async function loadEarlier() {
    const oldest = messages[0];
    if (!oldest || loadingEarlier) return;

    setLoadingEarlier(true);
    try {
      const response = await fetch(
        `/api/messages/${conversation.id}?before=${encodeURIComponent(oldest.id)}`,
        { cache: "no-store" },
      );
      if (response.ok) {
        const data = (await response.json()) as {
          messages: MessageView[];
          hasEarlier: boolean;
        };
        prependedFromRef.current = scrollRef.current?.scrollHeight ?? null;
        setMessages((current) => mergeMessages(data.messages, current));
        setHasEarlier(data.hasEarlier);
      }
    } finally {
      setLoadingEarlier(false);
    }
  }

  async function send() {
    const body = draft.trim();
    if (!body) return;
    if (body.length > MESSAGE_MAX_LENGTH) {
      setError(`Keep it under ${MESSAGE_MAX_LENGTH.toLocaleString("en-US")} characters.`);
      return;
    }

    const key = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    followRef.current = true;
    setPending((current) => [...current, { key, body }]);
    setDraft("");
    setError(null);

    const result = await sendMessage(conversation.id, body).catch(() => ({
      ok: false as const,
      error: "That did not send. Check the connection and try again.",
    }));

    setPending((current) => current.filter((item) => item.key !== key));
    if (result.ok) {
      setMessages((current) => mergeMessages(current, [result.message]));
    } else {
      setError(result.error);
      setDraft((current) => current || body);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a new line. Never mid-composition, or a
    // Japanese or Chinese keyboard would send half a word.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const items = useMemo(() => {
    const out: Item[] = [];
    let previousDay: string | null = null;
    let previous: MessageView | null = null;

    for (const message of messages) {
      const at = new Date(message.createdAt);
      const day = dayKey(at, timeZone);
      if (day !== previousDay) {
        out.push({ type: "day", key: `day-${day}`, label: dayHeading(at, timeZone) });
        previousDay = day;
        previous = null;
      }

      const continues =
        previous !== null &&
        (previous.author?.id ?? null) === (message.author?.id ?? null) &&
        at.getTime() - new Date(previous.createdAt).getTime() < RUN_GAP_MS;

      if (continues) {
        const last = out[out.length - 1];
        if (last.type === "message") last.endsRun = false;
      }

      out.push({
        type: "message",
        key: message.id,
        message,
        startsRun: !continues,
        endsRun: true,
      });
      previous = message;
    }
    return out;
  }, [messages, timeZone]);

  const subtitle = isGroup
    ? `${conversation.others.map((person) => person.name).join(", ")} and you`
    : conversation.others[0]
      ? conversation.others[0].isActive
        ? (conversation.others[0].position ?? "Direct message")
        : "Deactivated"
      : "";

  const placeholder = isGroup
    ? `Message ${conversation.title}`
    : `Message ${firstName(conversation.others[0]?.name ?? conversation.title)}`;

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Link
          href="/messages"
          aria-label="All messages"
          className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink lg:hidden"
        >
          <ArrowLeft className="h-4.5 w-4.5" strokeWidth={1.75} />
        </Link>
        <ConversationAvatar kind={conversation.kind} others={conversation.others} />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{conversation.title}</h2>
          {subtitle ? <p className="truncate text-xs text-ink-muted">{subtitle}</p> : null}
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4"
        role="log"
        aria-label={`Messages in ${conversation.title}`}
      >
        {hasEarlier ? (
          <div className="mb-2 flex justify-center">
            <Button variant="ghost" size="sm" onClick={loadEarlier} disabled={loadingEarlier}>
              {loadingEarlier ? "Loading…" : "Load earlier messages"}
            </Button>
          </div>
        ) : null}

        {messages.length === 0 && pending.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-muted">
            {isGroup
              ? `This is the start of ${conversation.title}.`
              : `This is the start of your conversation with ${firstName(conversation.title)}.`}
          </p>
        ) : null}

        {items.map((item) =>
          item.type === "day" ? (
            <div key={item.key} className="my-4 flex items-center gap-3" role="separator">
              <span className="h-px flex-1 bg-line" />
              <span className="text-[0.6875rem] font-medium text-ink-subtle">{item.label}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          ) : (
            <Bubble
              key={item.key}
              message={item.message}
              mine={item.message.author?.id === viewerId}
              showName={isGroup && item.startsRun}
              showAvatar={isGroup}
              startsRun={item.startsRun}
              endsRun={item.endsRun}
              timeZone={timeZone}
            />
          ),
        )}

        {pending.map((item) => (
          <div key={item.key} className="mt-0.5 flex justify-end">
            <div className="flex max-w-[80%] flex-col items-end sm:max-w-[70%]">
              <div className="rounded-2xl bg-brand px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap text-brand-ink opacity-60 [overflow-wrap:anywhere]">
                {item.body}
              </div>
              <p className="mt-0.5 px-1 text-[0.6875rem] text-ink-subtle">Sending…</p>
            </div>
          </div>
        ))}
      </div>

      {reachable ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          className="border-t border-line p-3"
        >
          {error ? (
            <p role="alert" className="mb-2 px-1 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <label htmlFor="message-body" className="sr-only">
              Message
            </label>
            <Textarea
              id="message-body"
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              maxLength={MESSAGE_MAX_LENGTH}
              placeholder={placeholder}
              autoComplete="off"
              className="min-h-9.5 resize-none"
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Send"
              disabled={draft.trim() === ""}
              className="h-9.5 w-9.5 shrink-0"
            >
              <SendHorizontal className="h-4 w-4" strokeWidth={2} />
            </Button>
          </div>
        </form>
      ) : (
        <p className="border-t border-line px-4 py-3 text-sm text-ink-muted">
          {isGroup
            ? "Everybody else in this group has been deactivated, so nothing new can be sent here."
            : `${conversation.title} has been deactivated, so nothing new can be sent here.`}
        </p>
      )}
    </Card>
  );
}

function Bubble({
  message,
  mine,
  showName,
  showAvatar,
  startsRun,
  endsRun,
  timeZone,
}: {
  message: MessageView;
  mine: boolean;
  showName: boolean;
  showAvatar: boolean;
  startsRun: boolean;
  endsRun: boolean;
  timeZone: string;
}) {
  const at = new Date(message.createdAt);
  const time = timeOfDay(at, timeZone);
  const name = message.author?.name ?? "Former teammate";

  return (
    <div
      className={cn(
        "flex items-end gap-2",
        mine ? "justify-end" : "justify-start",
        startsRun ? "mt-3" : "mt-0.5",
      )}
    >
      {!mine && showAvatar ? (
        <div className="w-7 shrink-0">
          {endsRun ? (
            <Avatar name={name} imageUrl={message.author?.avatarUrl} size="sm" />
          ) : null}
        </div>
      ) : null}

      <div
        className={cn(
          "flex max-w-[80%] flex-col sm:max-w-[70%]",
          mine ? "items-end" : "items-start",
        )}
      >
        {showName && !mine ? (
          <p className="mb-0.5 px-1 text-xs font-medium text-ink-muted">{name}</p>
        ) : null}
        <div
          title={`${dayHeading(at, timeZone)} at ${time}`}
          className={cn(
            "rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
            mine ? "bg-brand text-brand-ink" : "bg-surface-3 text-ink",
          )}
        >
          {splitLinks(message.body).map((part, index) =>
            part.href ? (
              <a
                key={index}
                href={part.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className={cn(
                  "underline underline-offset-2",
                  mine ? "text-brand-ink" : "text-brand",
                )}
              >
                {part.text}
              </a>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )}
        </div>
        {endsRun ? (
          <p className="mt-0.5 px-1 text-[0.6875rem] text-ink-subtle">
            <time dateTime={message.createdAt}>{time}</time>
          </p>
        ) : null}
      </div>
    </div>
  );
}

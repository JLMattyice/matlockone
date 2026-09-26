"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { ArrowLeft, Briefcase, ImagePlus, SendHorizontal, X } from "lucide-react";

import { ConversationAvatar } from "./conversation-avatar";
import { sendMessage, type SendResult } from "@/app/(app)/messages/actions";
import { Avatar } from "@/components/ui/avatar";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/form";
import {
  dayHeading,
  dayKey,
  MAX_PHOTOS_PER_MESSAGE,
  MESSAGE_MAX_LENGTH,
  mergeMessages,
  splitLinks,
  timeOfDay,
  type MessageView,
} from "@/lib/chat";
import type { ConversationDetail } from "@/lib/conversations";
import { downscaleImage } from "@/lib/downscale-image";
import { cn } from "@/lib/utils";

/**
 * One open conversation.
 *
 * New messages arrive by polling every few seconds while the tab is visible,
 * and not at all while it is hidden — a phone in a pocket should not be
 * asking a server anything. Sending shows the message at once, faded, and
 * swaps in the saved one when the server answers; a failure puts the text and
 * the photos back rather than losing them.
 */

const POLL_MS = 4000;
/** Consecutive messages from one person closer than this read as one block. */
const RUN_GAP_MS = 5 * 60 * 1000;
/** Close enough to the bottom that a new message should scroll into view. */
const NEAR_BOTTOM_PX = 120;
/** About six lines; past this the box scrolls instead of growing. */
const COMPOSER_MAX_PX = 160;

type ChosenPhoto = { key: string; file: File; url: string };
type Pending = { key: string; body: string; photoUrls: string[] };

type Item =
  | { type: "day"; key: string; label: string }
  | {
      type: "message";
      key: string;
      message: MessageView;
      startsRun: boolean;
      endsRun: boolean;
    };

/** A failure worth showing as it is, rather than as "check the connection". */
class SendProblem extends Error {}

export function Thread({
  conversation,
  viewerId,
  initialMessages,
  initialHasEarlier,
  timeZone,
  canSendPhotos,
}: {
  conversation: ConversationDetail;
  viewerId: string;
  initialMessages: MessageView[];
  initialHasEarlier: boolean;
  timeZone: string;
  /** The viewer's role may add files. Photos go only in job threads. */
  canSendPhotos: boolean;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [hasEarlier, setHasEarlier] = useState(initialHasEarlier);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [draft, setDraft] = useState("");
  const [photos, setPhotos] = useState<ChosenPhoto[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const newestRef = useRef<string | null>(initialMessages.at(-1)?.createdAt ?? null);
  /** Whether to follow new messages down, i.e. the reader is at the bottom. */
  const followRef = useRef(true);
  /** Scroll height before older messages were put above, to hold position. */
  const prependedFromRef = useRef<number | null>(null);
  /** Every preview URL still alive, so leaving the thread can release them. */
  const urlsRef = useRef(new Set<string>());
  /** The photos chosen right now, for code that runs after an await. */
  const photosRef = useRef<ChosenPhoto[]>([]);

  const job = conversation.job;
  const isGroup = conversation.kind === "GROUP";
  const isJob = conversation.kind === "JOB";
  const canAttach = isJob && job !== null && canSendPhotos;
  // A job thread always has somebody to read it: the office.
  const reachable = isJob || conversation.others.some((person) => person.isActive);
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

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

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

  function release(chosen: ChosenPhoto[]) {
    for (const photo of chosen) {
      URL.revokeObjectURL(photo.url);
      urlsRef.current.delete(photo.url);
    }
  }

  async function onPickPhotos(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    // Cleared so picking the same photo again after removing it still fires.
    event.target.value = "";
    if (picked.length === 0) return;

    const room = MAX_PHOTOS_PER_MESSAGE - photos.length;
    if (picked.length > room) {
      setError(`Up to ${MAX_PHOTOS_PER_MESSAGE} photos in one message.`);
    } else {
      setError(null);
    }

    setPreparing(true);
    try {
      const ready = await Promise.all(picked.slice(0, Math.max(room, 0)).map(downscaleImage));
      const chosen = ready.map((file) => {
        const url = URL.createObjectURL(file);
        urlsRef.current.add(url);
        return { key: `${url}`, file, url };
      });
      setPhotos((current) => [...current, ...chosen]);
    } finally {
      setPreparing(false);
    }
  }

  function removePhoto(key: string) {
    release(photos.filter((photo) => photo.key === key));
    setPhotos((current) => current.filter((photo) => photo.key !== key));
  }

  /**
   * Hands each photo to the store the way the rest of the app does: straight
   * from the browser where the store can take it, which a hosted deployment
   * needs because its functions refuse request bodies this size; otherwise
   * inside the message itself, which is how the desktop build's own server
   * receives it.
   */
  async function packPhotos(chosen: ChosenPhoto[], formData: FormData) {
    if (!job) return;
    const tickets: string[] = [];

    for (const { file } of chosen) {
      const response = await fetch("/api/files/upload-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "job",
          entityId: job.id,
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new SendProblem(body?.error ?? `${file.name} could not be uploaded.`);
      }

      const ticket = await response.json();
      if (!ticket.direct) {
        formData.append("photos", file);
        continue;
      }

      const put = await fetch(ticket.upload.url, {
        method: ticket.upload.method,
        headers: ticket.upload.headers,
        body: file,
      });
      if (!put.ok) throw new SendProblem(`${file.name} could not be uploaded.`);
      tickets.push(ticket.ticket);
    }

    if (tickets.length > 0) formData.set("tickets", JSON.stringify(tickets));
  }

  async function send() {
    const body = draft.trim();
    const chosen = photos;
    if ((!body && chosen.length === 0) || preparing) return;
    if (body.length > MESSAGE_MAX_LENGTH) {
      setError(`Keep it under ${MESSAGE_MAX_LENGTH.toLocaleString("en-US")} characters.`);
      return;
    }

    const key = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    followRef.current = true;
    setPending((current) => [...current, { key, body, photoUrls: chosen.map((p) => p.url) }]);
    setDraft("");
    setPhotos([]);
    setError(null);

    let result: SendResult;
    try {
      const formData = new FormData();
      formData.set("conversationId", conversation.id);
      formData.set("body", body);
      if (chosen.length > 0) await packPhotos(chosen, formData);
      result = await sendMessage(formData);
    } catch (problem) {
      result = {
        ok: false,
        error:
          problem instanceof SendProblem
            ? problem.message
            : "That did not send. Check the connection and try again.",
      };
    }

    setPending((current) => current.filter((item) => item.key !== key));
    if (result.ok) {
      release(chosen);
      setMessages((current) => mergeMessages(current, [result.message]));
      if (result.warning) setError(result.warning);
    } else {
      setError(result.error);
      setDraft((current) => current || body);
      // Put the photos back unless new ones were picked while this was sending.
      if (photosRef.current.length > 0) release(chosen);
      else setPhotos(chosen);
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

  const subtitle = isJob
    ? job?.clientName
      ? `${job.clientName} · the office and the crew on it`
      : "The office and the crew on this job"
    : isGroup
      ? `${conversation.others.map((person) => person.name).join(", ")} and you`
      : conversation.others[0]
        ? conversation.others[0].isActive
          ? (conversation.others[0].position ?? "Direct message")
          : "Deactivated"
        : "";

  const placeholder =
    isJob || isGroup
      ? `Message ${isJob && job ? job.number : conversation.title}`
      : `Message ${firstName(conversation.others[0]?.name ?? conversation.title)}`;

  const nothingToSend = draft.trim() === "" && photos.length === 0;

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
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-ink">{conversation.title}</h2>
          {subtitle ? <p className="truncate text-xs text-ink-muted">{subtitle}</p> : null}
        </div>
        {job ? (
          <Link
            href={`/jobs/${job.id}`}
            className={buttonClasses("outline", "sm", "shrink-0")}
          >
            <Briefcase className="h-3.5 w-3.5" strokeWidth={2} />
            <span className="hidden sm:inline">View job</span>
            <span className="sm:hidden">Job</span>
          </Link>
        ) : null}
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
          <p className="mx-auto max-w-sm py-10 text-center text-sm text-ink-muted">
            {isJob
              ? "Nothing said about this job yet. The office and everyone on the job can read what is written here, and photos sent here are saved to the job."
              : isGroup
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
              showName={!isDirect(conversation.kind) && item.startsRun}
              showAvatar={!isDirect(conversation.kind)}
              startsRun={item.startsRun}
              endsRun={item.endsRun}
              timeZone={timeZone}
            />
          ),
        )}

        {pending.map((item) => (
          <div key={item.key} className="mt-0.5 flex justify-end">
            <div className="flex max-w-[80%] flex-col items-end gap-1 opacity-60 sm:max-w-[70%]">
              {item.photoUrls.length > 0 ? (
                <PhotoGrid
                  photos={item.photoUrls.map((url) => ({ key: url, src: url }))}
                  alt="Photo being sent"
                />
              ) : null}
              {item.body ? (
                <div className="rounded-2xl bg-brand px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap text-brand-ink [overflow-wrap:anywhere]">
                  {item.body}
                </div>
              ) : null}
              <p className="px-1 text-[0.6875rem] text-ink-subtle">
                {item.photoUrls.length > 0 ? "Uploading…" : "Sending…"}
              </p>
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

          {photos.length > 0 ? (
            <ul className="mb-2 flex gap-2 overflow-x-auto pb-1" aria-label="Photos to send">
              {photos.map((photo) => (
                <li key={photo.key} className="relative shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.url}
                    alt={photo.file.name}
                    className="h-16 w-16 rounded-lg border border-line object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removePhoto(photo.key)}
                    aria-label={`Remove ${photo.file.name}`}
                    className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-surface shadow-sm"
                  >
                    <X className="h-3 w-3" strokeWidth={2.5} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex items-end gap-2">
            {canAttach ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={onPickPhotos}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Add photos"
                  title="Add photos — they are saved to the job"
                  disabled={preparing || photos.length >= MAX_PHOTOS_PER_MESSAGE}
                  onClick={() => fileRef.current?.click()}
                  className="h-9.5 w-9.5 shrink-0"
                >
                  <ImagePlus className="h-4.5 w-4.5" strokeWidth={1.75} />
                </Button>
              </>
            ) : null}
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
              placeholder={preparing ? "Getting the photos ready…" : placeholder}
              autoComplete="off"
              className="min-h-9.5 resize-none"
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Send"
              disabled={nothingToSend || preparing}
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

function isDirect(kind: string) {
  return kind === "DIRECT";
}

/**
 * One photo large; several as a grid of squares.
 *
 * Fixed frames, cropped to fit, rather than each photo's own shape: a photo
 * only knows its size once it has loaded, and a thread that scrolled to the
 * bottom on opening would be left short of it as each one arrived.
 */
function PhotoGrid({
  photos,
  alt,
  linked = false,
}: {
  photos: { key: string; src: string }[];
  alt: string;
  linked?: boolean;
}) {
  const single = photos.length === 1;

  return (
    <div className={cn("grid gap-1", single ? "grid-cols-1" : "grid-cols-2")}>
      {photos.map((photo) => {
        const image = (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo.src}
            alt={alt}
            loading="lazy"
            className={cn(
              "block bg-surface-3 object-cover",
              single ? "h-48 w-64 rounded-2xl sm:h-56 sm:w-72" : "h-32 w-32 rounded-xl sm:h-36 sm:w-36",
            )}
          />
        );

        return linked ? (
          <a
            key={photo.key}
            href={photo.src}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-xl focus-visible:ring-2 focus-visible:ring-brand"
          >
            {image}
          </a>
        ) : (
          <span key={photo.key}>{image}</span>
        );
      })}
    </div>
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
  const hasPhotos = message.photos.length > 0;

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
          "flex max-w-[80%] flex-col gap-1 sm:max-w-[70%]",
          mine ? "items-end" : "items-start",
        )}
      >
        {showName && !mine ? (
          <p className="px-1 text-xs font-medium text-ink-muted">{name}</p>
        ) : null}

        {hasPhotos ? (
          <PhotoGrid
            photos={message.photos.map((photo) => ({
              key: photo.id,
              src: `/api/files/${photo.id}`,
            }))}
            alt={`Photo from ${name}`}
            linked
          />
        ) : null}

        {message.body ? (
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
        ) : !hasPhotos ? (
          // Only photos, and they have since been deleted from the job.
          <div className="rounded-2xl border border-dashed border-line px-3.5 py-2 text-sm text-ink-subtle italic">
            Photo removed
          </div>
        ) : null}

        {endsRun ? (
          <p className="px-1 text-[0.6875rem] text-ink-subtle">
            <time dateTime={message.createdAt}>{time}</time>
          </p>
        ) : null}
      </div>
    </div>
  );
}

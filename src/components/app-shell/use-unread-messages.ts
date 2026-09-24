"use client";

import { useEffect, useRef, useState } from "react";

import { MESSAGES_HREF } from "@/lib/navigation";
import { UNREAD_CHANGED_EVENT } from "@/lib/chat";

/** Slow while somebody is working elsewhere in the app; quicker in the inbox. */
const POLL_MS = 30_000;
const POLL_IN_INBOX_MS = 8_000;

/**
 * The unread team-message count, kept current while the app is open.
 *
 * Starts from what the server rendered and follows it whenever a refresh
 * brings a new number. Between refreshes it asks on a timer, but only while
 * the tab is visible, and straight away when somebody comes back to it — the
 * moment a technician unlocks their phone is the moment the count matters.
 */
export function useUnreadMessages(initial: number, enabled: boolean, pathname: string) {
  const [count, setCount] = useState(initial);
  const countRef = useRef(initial);

  useEffect(() => {
    setCount(initial);
    countRef.current = initial;
  }, [initial]);

  const inInbox = pathname === MESSAGES_HREF || pathname.startsWith(`${MESSAGES_HREF}/`);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;

    async function check() {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/messages/unread", { cache: "no-store" });
        if (!response.ok || stopped) return;
        const data = (await response.json()) as { unread?: unknown };
        if (typeof data.unread !== "number") return;

        if (data.unread !== countRef.current) {
          countRef.current = data.unread;
          setCount(data.unread);
          window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT));
        }
      } catch {
        // No signal; the next tick asks again.
      }
    }

    const timer = setInterval(check, inInbox ? POLL_IN_INBOX_MS : POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled, inInbox]);

  return count;
}

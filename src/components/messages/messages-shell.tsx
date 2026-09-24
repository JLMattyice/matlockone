"use client";

import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { UNREAD_CHANGED_EVENT } from "@/lib/chat";
import { cn } from "@/lib/utils";

/**
 * The inbox beside the open conversation.
 *
 * Two panes on a desktop. On a phone there is room for one, so the list shows
 * until a thread is opened and the thread then takes the whole screen, with a
 * back arrow in its header — the layout the crew already knows from texting.
 */
export function MessagesShell({
  list,
  children,
}: {
  list: React.ReactNode;
  children: React.ReactNode;
}) {
  const segment = useSelectedLayoutSegment();
  const router = useRouter();
  const threadOpen = segment !== null;
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<string | null>(null);

  // Fill the screen below wherever this starts, so the thread scrolls inside
  // itself and the composer stays in reach. Measured rather than assumed: a
  // banner above <main> — demo mode, a licence about to lapse — moves the top
  // by an amount CSS cannot know, and on a phone that pushed the send box off
  // the bottom of the screen.
  useLayoutEffect(() => {
    function measure() {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const main = el.closest("main");
      const bottom = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      setHeight(`calc(100dvh - ${Math.round(top + bottom)}px)`);
    }

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // The inbox is rendered on the server. When the sidebar's poll notices
  // something new has arrived, re-render it so the thread moves to the top.
  useEffect(() => {
    const refresh = () => router.refresh();
    window.addEventListener(UNREAD_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(UNREAD_CHANGED_EVENT, refresh);
  }, [router]);

  return (
    // The classes are the first paint, before measuring: the top bar and
    // <main>'s padding, which is right whenever no banner is showing.
    <div
      ref={ref}
      style={height ? { height } : undefined}
      className="grid h-[calc(100dvh-6.5rem)] min-h-96 gap-4 lg:h-[calc(100dvh-7.5rem)] lg:grid-cols-[20rem_minmax(0,1fr)]"
    >
      <div className={cn("min-h-0", threadOpen && "hidden lg:block")}>{list}</div>
      <div className={cn("min-h-0", !threadOpen && "hidden lg:block")}>{children}</div>
    </div>
  );
}

"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A keyboard hint that matches the keyboard the person is actually using.
 *
 * Windows and Linux say Ctrl; macOS says ⌘. Showing a Mac symbol to a Windows
 * user is a small thing that makes software feel like it was written for
 * somebody else.
 *
 * The platform is only knowable in the browser, and the server has to render
 * *something* first. Rendering the wrong label and correcting it would trip
 * React's hydration check, so nothing is shown until the component mounts —
 * the space is reserved by the input's padding either way, so there is no jump.
 */
function useIsApplePlatform() {
  const [isApple, setIsApple] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    // userAgentData is the modern, non-deprecated source; navigator.platform is
    // the fallback that every browser still supports.
    const platform =
      (navigator as { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ??
      navigator.platform ??
      "";

    setIsApple(/mac|iphone|ipad|ipod/i.test(platform));
  }, []);

  return isApple;
}

export function Shortcut({
  keyLabel,
  className,
}: {
  /** The key pressed alongside the modifier, e.g. "K". */
  keyLabel: string;
  className?: string;
}) {
  const isApple = useIsApplePlatform();

  if (isApple === null) return null;

  return (
    <kbd
      aria-label={`${isApple ? "Command" : "Control"} ${keyLabel}`}
      className={cn(
        "pointer-events-none rounded border border-line bg-surface px-1.5 py-0.5 font-sans text-[0.625rem] text-ink-subtle",
        className,
      )}
    >
      {isApple ? `⌘${keyLabel}` : `Ctrl ${keyLabel}`}
    </kbd>
  );
}

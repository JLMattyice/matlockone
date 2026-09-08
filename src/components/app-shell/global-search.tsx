"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import { Shortcut } from "@/components/ui/shortcut";

/**
 * The search box in the header.
 *
 * Submitting navigates to /search?q=… rather than searching inline, so a set of
 * results is a real URL that can be shared, bookmarked and reloaded — and the
 * work happens on the server where the permission checks already live.
 */
export function GlobalSearch({ placeholder }: { placeholder: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(searchParams.get("q") ?? "");

  // Ctrl/Cmd+K focuses search from anywhere, the convention people expect.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length < 2) return;
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <form onSubmit={submit} className="relative w-full" role="search">
      <Search
        className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-subtle"
        strokeWidth={1.75}
        aria-hidden
      />
      <input
        ref={inputRef}
        type="search"
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Search everything"
        className="h-9 w-full rounded-lg border border-line bg-surface-2 pr-16 pl-9 text-sm text-ink transition-colors placeholder:text-ink-subtle hover:border-line-strong focus:border-brand"
      />
      <Shortcut
        keyLabel="K"
        className="absolute top-1/2 right-2.5 -translate-y-1/2"
      />
    </form>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";

/**
 * Any two dates: the pay period that is not a calendar week — the 1st to the
 * 15th, or two weeks that start on a Wednesday. The span goes into the URL
 * like every other filter, so it can be bookmarked and stepped from.
 *
 * A plain GET form underneath, so it still works before the page's script has
 * loaded on a slow phone.
 */
export function DateSpanForm({ path, from, to }: { path: string; from: string; to: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={path}
      method="get"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const first = String(data.get("from") ?? "");
        const last = String(data.get("to") ?? "");
        if (!first || !last) return;
        startTransition(() => router.push(`${path}?from=${first}&to=${last}`));
      }}
    >
      {/* On a phone the two dates share a row and Show sits under them. */}
      <Input type="date" name="from" defaultValue={from} required aria-label="From" className="w-auto min-w-0 flex-1 sm:flex-none" />
      <span className="text-sm text-ink-muted">to</span>
      <Input type="date" name="to" defaultValue={to} required aria-label="To" className="w-auto min-w-0 flex-1 sm:flex-none" />
      <Button type="submit" variant="outline" disabled={pending} className="w-full justify-center sm:w-auto">
        {pending ? "Loading…" : "Show"}
      </Button>
    </form>
  );
}

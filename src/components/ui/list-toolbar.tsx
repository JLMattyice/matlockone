"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Search, X } from "lucide-react";

import { Select } from "./form";
import { cn } from "@/lib/utils";

export type ToolbarFilter = {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  /** Label for the "no filter" option. */
  allLabel?: string;
};

/**
 * Search + filter controls that live in the URL rather than component state.
 *
 * Keeping the query string as the source of truth means a filtered list is
 * shareable and survives a refresh, and the server component re-renders with
 * real data instead of the page filtering an already-fetched array.
 */
export function ListToolbar({
  searchPlaceholder = "Search…",
  filters = [],
  right,
}: {
  searchPlaceholder?: string;
  filters?: ToolbarFilter[];
  right?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const urlQuery = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the box in step when the URL changes from elsewhere (back button,
  // a "clear filters" link) without fighting the user mid-keystroke.
  useEffect(() => {
    setQuery((current) => (current === urlQuery ? current : urlQuery));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery]);

  function push(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    // Any change to the result set invalidates the current page number.
    params.delete("page");
    const qs = params.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname));
  }

  function onSearchChange(value: string) {
    setQuery(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      push((params) => {
        if (value.trim()) params.set("q", value.trim());
        else params.delete("q");
      });
    }, 300);
  }

  const hasFilters =
    urlQuery !== "" || filters.some((f) => searchParams.get(f.name));

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-subtle"
          strokeWidth={1.75}
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="h-9.5 w-full rounded-lg border border-line bg-surface pr-3 pl-9 text-sm text-ink transition-colors placeholder:text-ink-subtle hover:border-line-strong focus:border-brand"
        />
      </div>

      {filters.map((filter) => (
        <Select
          key={filter.name}
          aria-label={filter.label}
          value={searchParams.get(filter.name) ?? ""}
          onChange={(e) =>
            push((params) => {
              if (e.target.value) params.set(filter.name, e.target.value);
              else params.delete(filter.name);
            })
          }
          className="sm:w-44"
        >
          <option value="">{filter.allLabel ?? `All ${filter.label}`}</option>
          {filter.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ))}

      {hasFilters ? (
        <button
          type="button"
          onClick={() => startTransition(() => router.replace(pathname))}
          className="inline-flex h-9.5 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
          Clear
        </button>
      ) : null}

      <div
        className={cn(
          "ml-auto flex items-center gap-2 transition-opacity",
          isPending && "opacity-60",
        )}
      >
        {right}
      </div>
    </div>
  );
}

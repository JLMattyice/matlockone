import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Page links that carry the current filters forward. Rendered on the server so
 * the URL stays the single source of truth for what the list is showing.
 */
export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  pathname,
  params,
  itemLabel = "records",
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  pathname: string;
  params: Record<string, string | undefined>;
  itemLabel?: string;
}) {
  if (total === 0) return null;

  const href = (targetPage: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    if (targetPage > 1) search.set("page", String(targetPage));
    const qs = search.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
      <p className="tabular text-xs text-ink-muted">
        Showing {first}–{last} of {total} {itemLabel}
      </p>

      {pageCount > 1 ? (
        <div className="flex items-center gap-1">
          <PageLink href={href(page - 1)} disabled={page <= 1} label="Previous page">
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
          </PageLink>

          <span className="tabular px-2 text-xs text-ink-muted">
            Page {page} of {pageCount}
          </span>

          <PageLink
            href={href(page + 1)}
            disabled={page >= pageCount}
            label="Next page"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </PageLink>
        </div>
      ) : null}
    </div>
  );
}

function PageLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const className = cn(
    "flex h-8 w-8 items-center justify-center rounded-lg border border-line transition-colors",
    disabled
      ? "cursor-not-allowed text-ink-subtle opacity-50"
      : "text-ink-muted hover:bg-surface-3 hover:text-ink",
  );

  if (disabled) {
    return (
      <span className={className} aria-disabled="true" aria-label={label}>
        {children}
      </span>
    );
  }

  return (
    <Link href={href} className={className} aria-label={label}>
      {children}
    </Link>
  );
}

import Link from "next/link";

import { cn } from "@/lib/utils";

export type TabLink = {
  href: string;
  label: string;
  count?: number;
  active: boolean;
};

/**
 * Navigation tabs backed by real links rather than client state, so each view
 * is its own URL and renders on the server with only the data it needs.
 */
export function TabLinks({ tabs }: { tabs: TabLink[] }) {
  return (
    <nav className="scrollbar-thin -mb-px flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? "page" : undefined}
          className={cn(
            "flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors",
            tab.active
              ? "border-brand font-medium text-brand"
              : "border-transparent text-ink-muted hover:text-ink",
          )}
        >
          {tab.label}
          {tab.count !== undefined ? (
            <span
              className={cn(
                "tabular rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium",
                tab.active
                  ? "bg-brand/12 text-brand"
                  : "bg-surface-3 text-ink-subtle",
              )}
            >
              {tab.count}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

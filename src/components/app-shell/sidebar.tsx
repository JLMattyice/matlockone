"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";

import { NavIcon } from "./nav-icon";
import type { ResolvedNavGroup } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export type SidebarBrand = {
  name: string;
  logoUrl: string | null;
  initials: string;
};

export function Sidebar({
  groups,
  brand,
}: {
  groups: ResolvedNavGroup[];
  brand: SidebarBrand;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile drawer whenever navigation completes.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="fixed top-3 left-3 z-40 flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted shadow-sm lg:hidden print:hidden"
      >
        <Menu className="h-4.5 w-4.5" strokeWidth={1.75} />
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-surface transition-transform lg:translate-x-0 print:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-line px-4">
          <Link href="/dashboard" className="flex min-w-0 items-center gap-2.5">
            {brand.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={brand.logoUrl}
                alt=""
                className="h-8 w-8 rounded-lg object-cover"
              />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-xs font-bold text-brand-ink">
                {brand.initials}
              </span>
            )}
            <span className="truncate text-sm font-semibold text-ink">
              {brand.name}
            </span>
          </Link>

          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-3 lg:hidden"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        <nav className="scrollbar-thin flex-1 space-y-6 overflow-y-auto px-3 py-4">
          {groups.map((group) => (
            <div key={group.title}>
              <p className="px-2.5 pb-1.5 text-[0.6875rem] font-semibold tracking-wider text-ink-subtle uppercase">
                {group.title}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active =
                    pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                          active
                            ? "bg-brand/10 font-medium text-brand"
                            : "text-ink-muted hover:bg-surface-3 hover:text-ink",
                        )}
                      >
                        <NavIcon name={item.icon} className="h-4.5 w-4.5 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}

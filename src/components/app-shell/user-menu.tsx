"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, Settings, UserRound } from "lucide-react";

import { logoutAction } from "@/app/(auth)/actions";
import { Badge } from "@/components/ui/badge";
import { ROLE_META, type Role } from "@/lib/constants";
import { cn, initials } from "@/lib/utils";

export function UserMenu({
  name,
  email,
  role,
  avatarUrl,
  canOpenSettings,
}: {
  name: string;
  email: string;
  role: Role;
  avatarUrl: string | null;
  canOpenSettings: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const meta = ROLE_META[role];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg py-1 pr-1.5 pl-1 transition-colors hover:bg-surface-3"
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-[0.6875rem] font-semibold text-brand-ink">
            {initials(name)}
          </span>
        )}
        <span className="hidden text-sm font-medium text-ink sm:block">{name}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-ink-subtle transition-transform",
            open && "rotate-180",
          )}
          strokeWidth={2}
        />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-60 overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
        >
          <div className="border-b border-line px-3.5 py-3">
            <p className="truncate text-sm font-medium text-ink">{name}</p>
            <p className="truncate text-xs text-ink-muted">{email}</p>
            <Badge tone={meta.tone} className="mt-2">
              {meta.label}
            </Badge>
          </div>

          <div className="p-1">
            <Link
              href="/settings/profile"
              role="menuitem"
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <UserRound className="h-4 w-4" strokeWidth={1.75} />
              Your profile
            </Link>

            {canOpenSettings ? (
              <Link
                href="/settings"
                role="menuitem"
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
              >
                <Settings className="h-4 w-4" strokeWidth={1.75} />
                Business settings
              </Link>
            ) : null}
          </div>

          <form action={logoutAction} className="border-t border-line p-1">
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-muted transition-colors hover:bg-danger/10 hover:text-danger"
            >
              <LogOut className="h-4 w-4" strokeWidth={1.75} />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

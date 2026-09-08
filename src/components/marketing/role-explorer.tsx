"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Lock,
  Users,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { NavIcon } from "@/components/app-shell/nav-icon";
import { Badge } from "@/components/ui/badge";
import type { Role } from "@/lib/constants";
import type { RoleView } from "@/lib/marketing";
import { cn } from "@/lib/utils";

/**
 * The page's instrument.
 *
 * Every claim rendered here comes from `roleViews()`, which reads the
 * application's own permission matrix. Nothing below decides what a role can
 * see; it only draws the answer.
 */

type RoleContextValue = {
  views: RoleView[];
  role: Role;
  setRole: (role: Role) => void;
  view: RoleView;
};

const RoleContext = React.createContext<RoleContextValue | null>(null);

export function RoleProvider({
  views,
  children,
}: {
  views: RoleView[];
  children: React.ReactNode;
}) {
  const [role, setRole] = React.useState<Role>("OWNER");
  const view = React.useMemo(
    () => views.find((candidate) => candidate.role === role) ?? views[0],
    [views, role],
  );

  const value = React.useMemo(
    () => ({ views, role, setRole, view }),
    [views, role, view],
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

function useRole() {
  const context = React.useContext(RoleContext);
  if (!context) throw new Error("Role components must sit inside RoleProvider");
  return context;
}

// ------------------------------------------------------------- the switch ---

/**
 * A real radiogroup rather than four buttons: roving focus, arrow keys, and one
 * tab stop, which is what a segmented control is supposed to be.
 */
export function RoleSwitch({ className }: { className?: string }) {
  const { views, role, setRole } = useRole();
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: React.KeyboardEvent) {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const index = views.findIndex((candidate) => candidate.role === role);
    const next = (index + step + views.length) % views.length;

    setRole(views[next].role);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="View the app as"
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex flex-wrap gap-1 rounded-xl border border-line bg-surface-2 p-1",
        className,
      )}
    >
      {views.map((candidate, index) => {
        const active = candidate.role === role;
        return (
          <button
            key={candidate.role}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => setRole(candidate.role)}
            className={cn(
              "rounded-lg px-3.5 py-2 text-sm font-medium transition-colors sm:px-4",
              active
                ? "bg-brand text-brand-ink shadow-sm"
                : "text-ink-muted hover:bg-surface-3 hover:text-ink",
            )}
          >
            {candidate.label}
          </button>
        );
      })}
    </div>
  );
}

/** Announces the consequence of the switch, for anyone not watching it happen. */
export function RoleAnnouncer() {
  const { view } = useRole();
  return (
    <p aria-live="polite" className="sr-only">
      {view.label}: {view.visibleCount} of {view.visibleCount + view.hiddenCount}{" "}
      sections available,{" "}
      {view.seesMoney ? "financial screens included" : "no financial access"}.
    </p>
  );
}

// -------------------------------------------------------------- the frame ---

type Tile = {
  label: string;
  value: string;
  sublabel?: string;
  icon: LucideIcon;
  tone: "brand" | "warning" | "danger" | "success";
};

/**
 * Authored demonstration data for a business that does not exist. Real figures
 * from a real customer are the one thing this page may not invent, so the frame
 * says so out loud.
 */
const MONEY_TILES: Tile[] = [
  {
    label: "Revenue this month",
    value: "$18,420.00",
    icon: CircleDollarSign,
    tone: "brand",
  },
  {
    label: "Outstanding",
    value: "$9,860.00",
    sublabel: "7 unpaid invoices",
    icon: Wallet,
    tone: "warning",
  },
  {
    label: "Overdue",
    value: "$1,240.00",
    sublabel: "2 past due",
    icon: AlertTriangle,
    tone: "danger",
  },
];

const CLIENT_TILE: Tile = {
  label: "Active clients",
  value: "128",
  icon: Users,
  tone: "brand",
};

const COMPLETED_TILE: Tile = {
  label: "Jobs completed",
  value: "34",
  icon: CheckCircle2,
  tone: "success",
};

/** The app's StatTile, rebuilt without the link so the frame is inert. */
function FrameTile({ tile, month }: { tile: Tile; month: string }) {
  const iconTone = {
    brand: "bg-brand/10 text-brand",
    warning: "bg-warning/10 text-warning",
    danger: "bg-danger/10 text-danger",
    success: "bg-success/10 text-success",
  }[tile.tone];

  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-ink-muted">{tile.label}</p>
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            iconTone,
          )}
        >
          <tile.icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </span>
      </div>
      <p className="tabular mt-3 text-2xl font-semibold tracking-tight text-ink">
        {tile.value}
      </p>
      <p className="mt-1 text-xs text-ink-subtle">{tile.sublabel ?? month}</p>
    </div>
  );
}

export function RoleAppFrame({ month }: { month: string }) {
  const { view } = useRole();
  const tiles = view.seesMoney
    ? [...MONEY_TILES, COMPLETED_TILE]
    : [CLIENT_TILE, COMPLETED_TILE];

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface-2 shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand text-[10px] font-bold text-brand-ink">
            RP
          </span>
          <span className="truncate text-sm font-semibold text-ink">
            Ridgeline Plumbing &amp; Heating
          </span>
        </div>
        <Badge tone={view.tone}>{view.label}</Badge>
      </div>

      <div className="grid gap-0 sm:grid-cols-[13rem_1fr]">
        <nav
          aria-label={`Navigation as ${view.label}`}
          className="hidden border-r border-line bg-surface p-3 sm:block"
        >
          {view.groups.map((group) => (
            <div key={group.title} className="mb-3 last:mb-0">
              <p className="px-2 pb-1 text-[10px] font-semibold tracking-wider text-ink-subtle uppercase">
                {group.title}
              </p>
              <ul>
                {group.items.map((item, index) => (
                  <li
                    key={item.label}
                    style={{ transitionDelay: `${index * 18}ms` }}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm",
                      "motion-safe:transition-[opacity,color] motion-safe:duration-300",
                      item.allowed
                        ? "text-ink-muted"
                        : "text-ink-subtle opacity-40",
                    )}
                  >
                    {item.allowed ? (
                      <NavIcon name={item.icon} className="h-4 w-4 shrink-0" />
                    ) : (
                      <Lock
                        className="h-4 w-4 shrink-0"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                    )}
                    <span className="truncate">{item.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-ink">
              Good evening, {view.role === "EMPLOYEE" ? "Tariq" : "Alex"}
            </p>
            <p className="text-xs text-ink-subtle">
              {view.jobScope === "all"
                ? "Every job in the company"
                : "Only jobs assigned to them"}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {tiles.map((tile) => (
              <FrameTile key={tile.label} tile={tile} month={month} />
            ))}
          </div>

          <p className="mt-3 text-xs text-ink-subtle">
            Demo data for a business that does not exist. The permissions are
            real.
          </p>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- the gate ---

/**
 * The page refusing to show its own financial section to a role that could not
 * open it in the product. Copy is lifted from the application's /no-access
 * screen, because that is what this visitor would actually meet.
 */
export function RoleGate({ children }: { children: React.ReactNode }) {
  const { view } = useRole();
  if (view.seesMoney) return <>{children}</>;

  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none select-none opacity-20 blur-[3px]"
      >
        {children}
      </div>

      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="max-w-sm rounded-card border border-line bg-surface p-6 text-center shadow-sm">
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-surface-3 text-ink-muted">
            <Lock className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </span>
          <p className="mt-3 text-sm font-semibold text-ink">
            You do not have access to that screen
          </p>
          <p className="mt-1.5 text-sm text-ink-muted">
            This account is set to {view.label}. {view.description} Switch back
            to Owner above to read this section.
          </p>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------- the ability table ---

export function RoleAbilities() {
  const { view } = useRole();

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm font-semibold text-ink">{view.label}</p>
        <p className="text-sm text-ink-muted">
          <span className="tabular font-medium text-ink">
            {view.permissionCount}
          </span>{" "}
          permissions ·{" "}
          <span className="tabular font-medium text-ink">
            {view.visibleCount}
          </span>{" "}
          of {view.visibleCount + view.hiddenCount} sections
        </p>
      </div>

      <ul className="mt-4 divide-y divide-line border-y border-line">
        {view.abilities.map((ability, index) => (
          <li
            key={ability.label}
            style={{ transitionDelay: `${index * 24}ms` }}
            className={cn(
              "flex items-center justify-between gap-4 py-2.5 text-sm",
              "motion-safe:transition-opacity motion-safe:duration-300",
              ability.allowed ? "text-ink" : "text-ink-subtle opacity-55",
            )}
          >
            <span>{ability.label}</span>
            {ability.allowed ? (
              <CheckCircle2
                className="h-4 w-4 shrink-0 text-success"
                strokeWidth={1.75}
                aria-label="Allowed"
              />
            ) : (
              <Lock
                className="h-4 w-4 shrink-0 text-ink-subtle"
                strokeWidth={1.75}
                aria-label="Blocked"
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

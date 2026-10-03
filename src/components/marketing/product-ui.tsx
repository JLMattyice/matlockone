"use client";

import * as React from "react";

import { NavIcon } from "@/components/app-shell/nav-icon";
import { cn } from "@/lib/utils";

import {
  MODULE_GROUPS,
  MODULES,
  type BadgeTone,
  type Module,
} from "./showcase";

/**
 * The product, drawn from the application's own component vocabulary.
 *
 * The screens come from the app's own sidebar (see showcase.ts). Figures are
 * authored demonstration data for a business that does not exist — the page
 * says so where a visitor could mistake them for a customer's real numbers.
 */

// ------------------------------------------------------------ the chrome ---

function Frame({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-line-strong bg-surface-3 shadow-2xl",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-line bg-surface-2 px-4 py-2.5">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-brand text-[9px] font-bold text-brand-ink">
          M
        </span>
        <span className="text-xs font-medium text-ink-muted">Matlock One</span>
        <span className="ml-auto hidden text-[11px] text-ink-subtle sm:block">
          Ridgeline Plumbing &amp; Heating
        </span>
      </div>
      {children}
    </div>
  );
}

// -------------------------------------------------------------- the chart ---

const REVENUE = [
  18, 24, 21, 30, 27, 36, 33, 41, 38, 47, 44, 52,
] as const;

// The twelve months to September, the month the sample figures are for.
const MONTHS = ["O", "N", "D", "J", "F", "M", "A", "M", "J", "J", "A", "S"];

/** The last `months` of the year, as the dashboard (six) or reports (twelve) shows them. */
function RevenueChart({
  height = 132,
  months = 12,
}: {
  height?: number;
  months?: number;
}) {
  const values = REVENUE.slice(-months);
  const labels = MONTHS.slice(-months);
  const width = 560;
  const max = Math.max(...values) * 1.12;
  const step = width / (values.length - 1);

  const points = values.map((value, index) => ({
    x: index * step,
    y: height - (value / max) * height,
  }));

  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");

  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Revenue rising over ${months} months`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="m1-revenue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1="0"
            x2={width}
            y1={height * fraction}
            y2={height * fraction}
            stroke="var(--line)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <path d={area} fill="url(#m1-revenue)" />
        <path
          d={line}
          fill="none"
          stroke="var(--brand)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r="3.5"
          fill="var(--gold)"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div
        aria-hidden
        className="mt-2 flex justify-between text-[10px] text-ink-subtle"
      >
        {labels.map((month, index) => (
          <span key={`${month}-${index}`}>{month}</span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------- hero dashboard ---

// The dashboard's own tiles, under its own names (business-health.ts).
const HERO_TILES = [
  { label: "Collected", value: "$42,850", note: "September" },
  { label: "Outstanding", value: "$9,860", note: "7 invoices" },
  { label: "Active jobs", value: "18", note: "Scheduled or under way" },
];

export function HeroDashboard() {
  return (
    <Frame>
      <div className="grid grid-cols-1 sm:grid-cols-[10.5rem_1fr]">
        <nav
          aria-hidden
          className="hidden border-r border-line bg-surface-2 p-3 sm:block"
        >
          {/*
            The first six, not the whole sidebar. The full list is the Platform
            section's job a screen below, and printing it twice spends the
            reveal early.
          */}
          {MODULES.slice(0, 6).map((module, index) => (
            <span
              key={module.id}
              className={cn(
                "mb-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px]",
                index === 0 ? "bg-brand/12 text-ink" : "text-ink-subtle",
              )}
            >
              <NavIcon
                name={module.icon}
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  index === 0 && "text-brand",
                )}
              />
              {module.label}
            </span>
          ))}
          <span className="mt-1 block px-2 text-[11px] text-ink-subtle">
            +{MODULES.length - 6} more
          </span>
        </nav>

        <div className="p-4 sm:p-5">
          <p className="text-sm font-medium text-ink">Good morning, Lane</p>

          <div className="mt-4 grid grid-cols-3 gap-3">
            {HERO_TILES.map((tile) => (
              <div
                key={tile.label}
                className="rounded-lg border border-line bg-surface-2 p-3"
              >
                <p className="text-[11px] text-ink-subtle">{tile.label}</p>
                <p className="tabular mt-1 text-xl font-semibold text-ink sm:text-2xl">
                  {tile.value}
                </p>
                <p className="mt-0.5 text-[10px] text-ink-subtle">
                  {tile.note}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-lg border border-line bg-surface-2 p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <p className="text-xs font-medium text-ink">Revenue</p>
              <p className="text-[10px] text-ink-subtle">Last six months</p>
            </div>
            <RevenueChart months={6} />
          </div>
        </div>
      </div>
    </Frame>
  );
}

// ------------------------------------------------------------ the modules ---

const TONES: Record<BadgeTone, string> = {
  green: "border-brand/30 bg-brand/12 text-brand",
  gold: "border-gold/30 bg-gold/12 text-gold",
  warn: "border-warning/30 bg-warning/12 text-warning",
  neutral: "border-line-strong bg-surface-3 text-ink-muted",
};

function Badge({ children, tone }: { children: string; tone: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

function ModulePanel({ module }: { module: Module }) {
  return (
    <Frame className="h-full">
      <div className="border-b border-line bg-surface-2 px-4 py-3">
        <p className="text-sm font-medium text-ink">{module.label}</p>
      </div>

      {module.chart ? (
        <div className="p-4 sm:p-5">
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-line bg-surface-2 p-3">
              <p className="text-[11px] text-ink-subtle">Invoiced</p>
              <p className="tabular mt-1 text-xl font-semibold text-ink">
                $52,400
              </p>
            </div>
            <div className="rounded-lg border border-line bg-surface-2 p-3">
              <p className="text-[11px] text-ink-subtle">Collected</p>
              <p className="tabular mt-1 text-xl font-semibold text-gold">
                $47,180
              </p>
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface-2 p-4">
            <RevenueChart height={112} />
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line">
                {module.columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      "px-4 py-2.5 text-[11px] font-medium tracking-wide text-ink-subtle uppercase",
                      column.align === "right" && "text-right",
                    )}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {module.rows.map((row, index) => (
                <tr
                  key={index}
                  className="border-b border-line last:border-0"
                >
                  {module.columns.map((column) => {
                    const value = row[column.key];
                    return (
                      <td
                        key={column.key}
                        className={cn(
                          "px-4 py-3 whitespace-nowrap",
                          column.align === "right" && "tabular text-right",
                          column.key === "status" ? "" : "text-ink-muted",
                        )}
                      >
                        {column.key === "status" && row.status ? (
                          <Badge tone={row.tone ?? "neutral"}>
                            {row.status}
                          </Badge>
                        ) : (
                          <span
                            className={cn(
                              index === 0 && column.key !== "status"
                                ? "text-ink"
                                : undefined,
                            )}
                          >
                            {value}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Frame>
  );
}

export function ProductShowcase() {
  const [active, setActive] = React.useState(MODULES[0].id);
  const module = MODULES.find((item) => item.id === active) ?? MODULES[0];

  return (
    // min-w-0 on both tracks: a grid item defaults to min-width:auto, so the
    // panel's nowrap table would otherwise widen the column past the viewport
    // and take the selector list out with it.
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[16rem_1fr] lg:gap-10">
      {/* Grouped under the sidebar's own headings, so the list reads the way
          the app does once someone is signed in. */}
      <div className="min-w-0 space-y-5">
        {MODULE_GROUPS.map((group) => (
          <div key={group.title}>
            <p className="px-3 text-[11px] font-medium tracking-[0.16em] text-ink-subtle uppercase">
              {group.title}
            </p>
            <ul className="mt-1.5 grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-1">
              {group.modules.map((item) => {
                const selected = item.id === active;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setActive(item.id)}
                      aria-pressed={selected}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                        selected
                          ? "border-brand/40 bg-brand/12 text-ink"
                          : "border-transparent text-ink-muted hover:border-line hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      <NavIcon
                        name={item.icon}
                        className={cn(
                          "h-4 w-4 shrink-0",
                          selected ? "text-brand" : "text-ink-subtle",
                        )}
                      />
                      {item.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {/* The list runs longer than any one screen, so on a wide window the
          screen stays in view while the list scrolls past it. */}
      <div className="min-w-0 lg:sticky lg:top-24 lg:self-start">
        <div className="mb-4">
          <h3 className="display text-2xl text-ink sm:text-3xl">
            {module.headline}
          </h3>
          <p className="mt-2 max-w-xl text-sm text-ink-muted">{module.body}</p>
        </div>
        <ModulePanel module={module} />
      </div>
    </div>
  );
}

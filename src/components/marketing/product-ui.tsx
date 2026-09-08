"use client";

import * as React from "react";
import {
  BarChart3,
  Briefcase,
  Calendar,
  CreditCard,
  FileText,
  FolderClosed,
  HardHat,
  LayoutDashboard,
  Receipt,
  Target,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The product, drawn from the application's own component vocabulary.
 *
 * Every module below exists in the software. Figures are authored demonstration
 * data for a business that does not exist — the page says so where a visitor
 * could mistake them for a customer's real numbers.
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

const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

function RevenueChart({ height = 132 }: { height?: number }) {
  const width = 560;
  const max = Math.max(...REVENUE) * 1.12;
  const step = width / (REVENUE.length - 1);

  const points = REVENUE.map((value, index) => ({
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
        aria-label="Revenue rising over twelve months"
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
        {MONTHS.map((month, index) => (
          <span key={`${month}-${index}`}>{month}</span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------- hero dashboard ---

const HERO_TILES = [
  { label: "Revenue", value: "$42,850", note: "this month" },
  { label: "Jobs", value: "18", note: "in progress" },
  { label: "Customers", value: "126", note: "active" },
];

export function HeroDashboard() {
  return (
    <Frame>
      <div className="grid sm:grid-cols-[10.5rem_1fr]">
        <nav
          aria-hidden
          className="hidden border-r border-line bg-surface-2 p-3 sm:block"
        >
          {/*
            Six, not all eleven. The full list is the Platform section's job a
            screen below, and printing it twice spends the reveal early.
          */}
          {MODULES.slice(0, 6).map((module, index) => (
            <span
              key={module.id}
              className={cn(
                "mb-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px]",
                index === 0 ? "bg-brand/12 text-ink" : "text-ink-subtle",
              )}
            >
              <module.icon
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  index === 0 && "text-brand",
                )}
                strokeWidth={1.75}
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
              <p className="text-xs font-medium text-ink">Revenue overview</p>
              <p className="text-[10px] text-ink-subtle">Last 12 months</p>
            </div>
            <RevenueChart />
          </div>
        </div>
      </div>
    </Frame>
  );
}

// ------------------------------------------------------------ the modules ---

type Column = { key: string; label: string; align?: "right" };
type Row = Record<string, string> & { status?: string; tone?: BadgeTone };
type BadgeTone = "green" | "gold" | "neutral" | "warn";

type Module = {
  id: string;
  label: string;
  icon: LucideIcon;
  headline: string;
  body: string;
  columns: Column[];
  rows: Row[];
  chart?: boolean;
};

const TONES: Record<BadgeTone, string> = {
  green: "border-brand/30 bg-brand/12 text-brand",
  gold: "border-gold/30 bg-gold/12 text-gold",
  warn: "border-warning/30 bg-warning/12 text-warning",
  neutral: "border-line-strong bg-surface-3 text-ink-muted",
};

const MODULES: Module[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    headline: "The morning read",
    body: "Money in, money owed, what is booked today and what is running late — before the first call.",
    columns: [
      { key: "item", label: "Today" },
      { key: "detail", label: "Detail" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { item: "Booked today", detail: "6 jobs · 4 crew", status: "On track", tone: "green" },
      { item: "Awaiting payment", detail: "$9,860 across 7 invoices", status: "Sent", tone: "neutral" },
      { item: "Past due", detail: "$1,240 across 2 invoices", status: "Overdue", tone: "warn" },
      { item: "Quotes out", detail: "$18,300 across 5 estimates", status: "Pending", tone: "gold" },
    ],
  },
  {
    id: "customers",
    label: "Customers",
    icon: Users,
    headline: "One record per customer",
    body: "Every address, every job, every quote and every dollar they have ever paid, on one page.",
    columns: [
      { key: "name", label: "Customer" },
      { key: "where", label: "Location" },
      { key: "jobs", label: "Jobs" },
      { key: "balance", label: "Balance", align: "right" },
    ],
    rows: [
      { name: "Lakeshore Dental", where: "Fairhaven", jobs: "14", balance: "$0.00" },
      { name: "Bev Hollingsworth", where: "Kingsbury", jobs: "3", balance: "$480.00" },
      { name: "Oscar Nakamura", where: "Beaumont Ave", jobs: "7", balance: "$0.00" },
      { name: "Delia Moreau", where: "Old Mill Ct", jobs: "2", balance: "$1,240.00" },
    ],
  },
  {
    id: "leads",
    label: "Leads",
    icon: Target,
    headline: "Before they are customers",
    body: "Where each enquiry came from, what it is worth, and which ones turned into paying work.",
    columns: [
      { key: "name", label: "Lead" },
      { key: "source", label: "Source" },
      { key: "value", label: "Value", align: "right" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { name: "Marisol Vega", source: "Referral", value: "$3,200", status: "Quoted", tone: "gold" },
      { name: "Tom Delacroix", source: "Google", value: "$980", status: "Contacted", tone: "neutral" },
      { name: "Priya Raghavan", source: "Repeat", value: "$6,400", status: "Won", tone: "green" },
    ],
  },
  {
    id: "jobs",
    label: "Jobs",
    icon: Briefcase,
    headline: "The work itself",
    body: "Materials, hours, before-and-after photos and notes — all attached to the job they belong to.",
    columns: [
      { key: "ref", label: "Job" },
      { key: "customer", label: "Customer" },
      { key: "crew", label: "Crew" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { ref: "JOB-1167", customer: "Lakeshore Dental", crew: "Priya, Tom", status: "In progress", tone: "green" },
      { ref: "JOB-1166", customer: "Oscar Nakamura", crew: "Simone", status: "Scheduled", tone: "neutral" },
      { ref: "JOB-1164", customer: "Delia Moreau", crew: "Tariq", status: "Complete", tone: "gold" },
    ],
  },
  {
    id: "scheduling",
    label: "Scheduling",
    icon: Calendar,
    headline: "Drag it to move it",
    body: "Day, week and month. Unscheduled work waits in a queue you drag onto the grid; recurring visits are real bookings you can move one at a time.",
    columns: [
      { key: "time", label: "Time" },
      { key: "what", label: "Job" },
      { key: "who", label: "Crew" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { time: "08:30", what: "AC unit replacement", who: "Priya + Tom", status: "Confirmed", tone: "green" },
      { time: "10:30", what: "Drain clearing", who: "Simone", status: "Confirmed", tone: "green" },
      { time: "11:30", what: "Panel upgrade — quote", who: "Tariq", status: "Scheduled", tone: "neutral" },
      { time: "14:00", what: "Thermostat replacement", who: "Priya", status: "On site", tone: "gold" },
    ],
  },
  {
    id: "estimates",
    label: "Estimates",
    icon: FileText,
    headline: "Quotes that turn into work",
    body: "The customer accepts on a private link. An accepted quote becomes a scheduled job without anything being retyped.",
    columns: [
      { key: "ref", label: "Estimate" },
      { key: "customer", label: "Customer" },
      { key: "total", label: "Total", align: "right" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { ref: "EST-1043", customer: "Bev Hollingsworth", total: "$2,480.00", status: "Accepted", tone: "green" },
      { ref: "EST-1042", customer: "Marisol Vega", total: "$3,200.00", status: "Viewed", tone: "gold" },
      { ref: "EST-1041", customer: "Tom Delacroix", total: "$980.00", status: "Sent", tone: "neutral" },
    ],
  },
  {
    id: "invoices",
    label: "Invoices",
    icon: Receipt,
    headline: "Billed, and chased",
    body: "Amounts are whole cents, never floating point. Overdue is worked out from the calendar, so an invoice cannot sit in the database claiming to be current the day after it lapsed.",
    columns: [
      { key: "ref", label: "Invoice" },
      { key: "customer", label: "Customer" },
      { key: "balance", label: "Balance", align: "right" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { ref: "INV-0461", customer: "Lakeshore Dental", balance: "$0.00", status: "Paid", tone: "green" },
      { ref: "INV-0460", customer: "Delia Moreau", balance: "$1,240.00", status: "Overdue", tone: "warn" },
      { ref: "INV-0459", customer: "Bev Hollingsworth", balance: "$480.00", status: "Part paid", tone: "gold" },
    ],
  },
  {
    id: "payments",
    label: "Payments",
    icon: CreditCard,
    headline: "However you already take money",
    body: "PayPal, Stripe, Square, or a payment link you already have. Customers pay on the processor's own page — Matlock One never sees a card.",
    columns: [
      { key: "date", label: "Date" },
      { key: "customer", label: "Customer" },
      { key: "method", label: "Method" },
      { key: "amount", label: "Amount", align: "right" },
    ],
    rows: [
      { date: "Sep 4", customer: "Lakeshore Dental", method: "PayPal", amount: "$2,480.00" },
      { date: "Sep 2", customer: "Oscar Nakamura", method: "Card · Stripe", amount: "$615.00" },
      { date: "Aug 29", customer: "Bev Hollingsworth", method: "Check", amount: "$500.00" },
    ],
  },
  {
    id: "team",
    label: "Team",
    icon: HardHat,
    headline: "Who can see what",
    body: "An employee sees the jobs assigned to them and nothing financial. Roles are re-checked on the server for every page and every action.",
    columns: [
      { key: "name", label: "Name" },
      { key: "role", label: "Role" },
      { key: "week", label: "This week" },
      { key: "status", label: "Money" },
    ],
    rows: [
      { name: "Lane Matlock", role: "Owner", week: "—", status: "Full access", tone: "gold" },
      { name: "Priya Raghavan", role: "Manager", week: "32h", status: "Billing", tone: "green" },
      { name: "Tariq Nasser", role: "Employee", week: "38h", status: "No access", tone: "neutral" },
    ],
  },
  {
    id: "documents",
    label: "Documents",
    icon: FolderClosed,
    headline: "Photos and paperwork, attached",
    body: "Before-and-after photos pair up on the job. Files are served by database id and scoped to your business — a filename never selects a file.",
    columns: [
      { key: "file", label: "File" },
      { key: "job", label: "Attached to" },
      { key: "size", label: "Size", align: "right" },
    ],
    rows: [
      { file: "panel-before.jpg", job: "JOB-1164", size: "2.4 MB" },
      { file: "panel-after.jpg", job: "JOB-1164", size: "2.1 MB" },
      { file: "permit-4471.pdf", job: "JOB-1167", size: "184 KB" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: BarChart3,
    headline: "Billed is not the same as banked",
    body: "Invoiced and collected are shown side by side rather than merged into one revenue number, because billing in a month is not the same as being paid in it.",
    columns: [],
    rows: [],
    chart: true,
  },
];

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
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr] lg:gap-10">
      <div className="min-w-0">
        <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-1">
          {MODULES.map((item) => {
            const selected = item.id === active;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setActive(item.id)}
                  aria-pressed={selected}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                    selected
                      ? "border-brand/40 bg-brand/12 text-ink"
                      : "border-transparent text-ink-muted hover:border-line hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  <item.icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      selected ? "text-brand" : "text-ink-subtle",
                    )}
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="min-w-0">
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

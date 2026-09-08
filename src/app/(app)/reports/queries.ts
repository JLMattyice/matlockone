import "server-only";

import {
  eachDayOfInterval,
  eachMonthOfInterval,
  eachWeekOfInterval,
  endOfDay,
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
  subYears,
} from "date-fns";

import {
  asStatus,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  type ExpenseCategory,
} from "@/lib/constants";
import { prisma } from "@/lib/db";

export const REPORT_PERIODS = [
  "week",
  "month",
  "quarter",
  "year",
  "all",
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export function isReportPeriod(value: unknown): value is ReportPeriod {
  return (
    typeof value === "string" &&
    (REPORT_PERIODS as readonly string[]).includes(value)
  );
}

export const PERIOD_LABELS: Record<ReportPeriod, string> = {
  week: "This week",
  month: "This month",
  quarter: "Last 3 months",
  year: "This year",
  all: "Last 12 months",
};

export type DateRange = { from: Date; to: Date; label: string };

/**
 * Resolves a named period into a concrete range, plus the previous range of the
 * same length so every figure can be shown against a comparable baseline.
 */
export function resolveRange(period: ReportPeriod): {
  current: DateRange;
  previous: DateRange;
  /** How the revenue series should be bucketed for this span. */
  granularity: "day" | "week" | "month";
} {
  const now = new Date();

  switch (period) {
    case "week": {
      const from = startOfWeek(now);
      const to = endOfWeek(now);
      return {
        current: { from, to, label: PERIOD_LABELS.week },
        previous: {
          from: subDays(from, 7),
          to: subDays(to, 7),
          label: "Previous week",
        },
        granularity: "day",
      };
    }
    case "quarter": {
      const from = startOfMonth(subMonths(now, 2));
      const to = endOfDay(now);
      return {
        current: { from, to, label: PERIOD_LABELS.quarter },
        previous: {
          from: subMonths(from, 3),
          to: subMonths(to, 3),
          label: "Previous 3 months",
        },
        granularity: "week",
      };
    }
    case "year": {
      const from = startOfYear(now);
      const to = endOfYear(now);
      return {
        current: { from, to, label: PERIOD_LABELS.year },
        previous: {
          from: startOfYear(subYears(now, 1)),
          to: endOfYear(subYears(now, 1)),
          label: "Last year",
        },
        granularity: "month",
      };
    }
    case "all": {
      const from = startOfMonth(subMonths(now, 11));
      const to = endOfDay(now);
      return {
        current: { from, to, label: PERIOD_LABELS.all },
        previous: {
          from: subMonths(from, 12),
          to: subMonths(to, 12),
          label: "Previous 12 months",
        },
        granularity: "month",
      };
    }
    case "month":
    default: {
      const from = startOfMonth(now);
      const to = endOfMonth(now);
      return {
        current: { from, to, label: PERIOD_LABELS.month },
        previous: {
          from: startOfMonth(subMonths(now, 1)),
          to: endOfMonth(subMonths(now, 1)),
          label: "Previous month",
        },
        granularity: "day",
      };
    }
  }
}

/**
 * Headline figures for a range, each paired with the same figure from the
 * preceding range.
 *
 * "Collected" counts payments received; "invoiced" counts invoices issued.
 * They are deliberately separate — money billed in a period is not money that
 * arrived in it, and conflating the two is the usual way these reports lie.
 */
export async function periodTotals(
  organizationId: string,
  range: DateRange,
) {
  const scope = { organizationId };

  const [collected, invoiced, jobsCompleted, activeClients, newClients] =
    await Promise.all([
      prisma.payment.aggregate({
        where: { ...scope, receivedAt: { gte: range.from, lte: range.to } },
        _sum: { amountCents: true },
        _count: true,
      }),
      prisma.invoice.aggregate({
        where: {
          ...scope,
          status: { not: "CANCELLED" },
          issueDate: { gte: range.from, lte: range.to },
        },
        _sum: { totalCents: true },
        _count: true,
      }),
      prisma.job.count({
        where: {
          ...scope,
          status: "COMPLETED",
          completedAt: { gte: range.from, lte: range.to },
        },
      }),
      // A client counts as active if they had work or a bill in the window.
      prisma.client.count({
        where: {
          ...scope,
          OR: [
            {
              jobs: {
                some: { scheduledStart: { gte: range.from, lte: range.to } },
              },
            },
            {
              invoices: {
                some: { issueDate: { gte: range.from, lte: range.to } },
              },
            },
          ],
        },
      }),
      prisma.client.count({
        where: { ...scope, createdAt: { gte: range.from, lte: range.to } },
      }),
    ]);

  return {
    collectedCents: collected._sum.amountCents ?? 0,
    paymentCount: collected._count,
    invoicedCents: invoiced._sum.totalCents ?? 0,
    invoiceCount: invoiced._count,
    jobsCompleted,
    activeClients,
    newClients,
    averageInvoiceCents:
      invoiced._count > 0
        ? Math.round((invoiced._sum.totalCents ?? 0) / invoiced._count)
        : 0,
  };
}

export type PeriodTotals = Awaited<ReturnType<typeof periodTotals>>;

/**
 * The empty time buckets for a range, plus the function that maps a date onto
 * one. Shared so the money-in and money-out series are bucketed by identical
 * rules — two series drawn side by side have to agree on where a week starts.
 *
 * Bucketed in JS rather than SQL because "week" and "month" boundaries differ
 * between SQLite and Postgres date functions, and this has to give the same
 * answer on both.
 */
function bucketsFor(range: DateRange, granularity: "day" | "week" | "month") {
  const starts =
    granularity === "day"
      ? eachDayOfInterval({ start: range.from, end: range.to })
      : granularity === "week"
        ? eachWeekOfInterval({ start: range.from, end: range.to })
        : eachMonthOfInterval({ start: range.from, end: range.to });

  const keyFor = (date: Date) =>
    granularity === "day"
      ? format(date, "yyyy-MM-dd")
      : granularity === "week"
        ? format(startOfWeek(date), "yyyy-MM-dd")
        : format(startOfMonth(date), "yyyy-MM");

  const labelFor = (date: Date) =>
    granularity === "day"
      ? format(date, "d")
      : granularity === "week"
        ? format(date, "MMM d")
        : format(date, "MMM");

  const buckets = starts.map((date) => ({
    date,
    key: keyFor(date),
    label: labelFor(date),
    inCents: 0,
    outCents: 0,
  }));

  return { buckets, keyFor };
}

/**
 * Money in and money out over time.
 *
 * One series, not two: paid separately they could be bucketed differently and
 * still look comparable on the chart.
 */
export async function cashFlowSeries(
  organizationId: string,
  range: DateRange,
  granularity: "day" | "week" | "month",
) {
  const window = { gte: range.from, lte: range.to };

  const [payments, expenses] = await Promise.all([
    prisma.payment.findMany({
      where: { organizationId, receivedAt: window },
      select: { amountCents: true, receivedAt: true },
    }),
    prisma.expense.findMany({
      where: { organizationId, spentAt: window },
      select: { amountCents: true, spentAt: true },
    }),
  ]);

  const { buckets, keyFor } = bucketsFor(range, granularity);
  const index = new Map(buckets.map((b) => [b.key, b]));

  for (const payment of payments) {
    const bucket = index.get(keyFor(payment.receivedAt));
    if (bucket) bucket.inCents += payment.amountCents;
  }

  for (const expense of expenses) {
    const bucket = index.get(keyFor(expense.spentAt));
    if (bucket) bucket.outCents += expense.amountCents;
  }

  return buckets;
}

export type CashFlowBucket = Awaited<ReturnType<typeof cashFlowSeries>>[number];

/** Top services by amount invoiced in the range. */
export async function revenueByService(
  organizationId: string,
  range: DateRange,
  take = 8,
) {
  const lines = await prisma.invoiceLineItem.findMany({
    where: {
      invoice: {
        organizationId,
        status: { not: "CANCELLED" },
        issueDate: { gte: range.from, lte: range.to },
      },
    },
    select: { name: true, kind: true, totalCents: true, quantity: true },
  });

  const grouped = new Map<
    string,
    { name: string; kind: string; totalCents: number; count: number }
  >();

  for (const line of lines) {
    const key = line.name.trim().toLowerCase();
    const existing = grouped.get(key);
    if (existing) {
      existing.totalCents += line.totalCents;
      existing.count += 1;
    } else {
      grouped.set(key, {
        name: line.name.trim(),
        kind: line.kind,
        totalCents: line.totalCents,
        count: 1,
      });
    }
  }

  return [...grouped.values()]
    .sort((a, b) => b.totalCents - a.totalCents)
    .slice(0, take);
}

/** Labor billed per person, from time logged in the range. */
export async function revenueByEmployee(
  organizationId: string,
  range: DateRange,
) {
  const entries = await prisma.timeEntry.findMany({
    where: {
      organizationId,
      startedAt: { gte: range.from, lte: range.to },
    },
    select: {
      minutes: true,
      hourlyRateCents: true,
      billable: true,
      user: { select: { id: true, name: true } },
    },
  });

  const grouped = new Map<
    string,
    { id: string; name: string; minutes: number; billableCents: number }
  >();

  for (const entry of entries) {
    const current = grouped.get(entry.user.id) ?? {
      id: entry.user.id,
      name: entry.user.name,
      minutes: 0,
      billableCents: 0,
    };

    current.minutes += entry.minutes;
    if (entry.billable) {
      current.billableCents += Math.round(
        (entry.minutes / 60) * entry.hourlyRateCents,
      );
    }

    grouped.set(entry.user.id, current);
  }

  return [...grouped.values()].sort((a, b) => b.minutes - a.minutes);
}

/** Where work came from, and how much of it converted. */
export async function leadSourcePerformance(
  organizationId: string,
  range: DateRange,
) {
  const rows = await prisma.lead.groupBy({
    by: ["source", "status"],
    where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
    _count: true,
    _sum: { estimatedValueCents: true },
  });

  const grouped = new Map<
    string,
    { source: string; total: number; won: number; valueCents: number }
  >();

  for (const row of rows) {
    const source = row.source ?? "UNKNOWN";
    const current = grouped.get(source) ?? {
      source,
      total: 0,
      won: 0,
      valueCents: 0,
    };

    current.total += row._count;
    if (row.status === "WON") {
      current.won += row._count;
      current.valueCents += row._sum.estimatedValueCents ?? 0;
    }

    grouped.set(source, current);
  }

  return [...grouped.values()].sort((a, b) => b.total - a.total);
}

/** Clients ranked by what they were billed in the range. */
export async function topClients(
  organizationId: string,
  range: DateRange,
  take = 8,
) {
  const rows = await prisma.invoice.groupBy({
    by: ["clientId"],
    where: {
      organizationId,
      status: { not: "CANCELLED" },
      issueDate: { gte: range.from, lte: range.to },
    },
    _sum: { totalCents: true },
    _count: true,
    orderBy: { _sum: { totalCents: "desc" } },
    take,
  });

  if (rows.length === 0) return [];

  const clients = await prisma.client.findMany({
    where: { id: { in: rows.map((r) => r.clientId) } },
    select: { id: true, displayName: true },
  });
  const nameById = new Map(clients.map((c) => [c.id, c.displayName]));

  return rows.map((row) => ({
    clientId: row.clientId,
    name: nameById.get(row.clientId) ?? "Removed client",
    invoicedCents: row._sum.totalCents ?? 0,
    invoiceCount: row._count,
  }));
}

/**
 * What went out in the range.
 *
 * "Job costs" is what was booked against a job and "overhead" is everything
 * else — the split follows the attribution the business actually recorded
 * rather than guessing from the category, so it can be trusted to mean what
 * someone typed.
 */
export async function expenseTotals(organizationId: string, range: DateRange) {
  const window = { gte: range.from, lte: range.to };

  const [spent, jobCosts, owed] = await Promise.all([
    prisma.expense.aggregate({
      where: { organizationId, spentAt: window },
      _sum: { amountCents: true, taxCents: true },
      _count: true,
    }),
    prisma.expense.aggregate({
      where: { organizationId, spentAt: window, jobId: { not: null } },
      _sum: { amountCents: true },
      _count: true,
    }),
    prisma.expense.aggregate({
      where: { organizationId, reimbursable: true, reimbursedAt: null },
      _sum: { amountCents: true },
      _count: true,
    }),
  ]);

  const spentCents = spent._sum.amountCents ?? 0;
  const jobCostCents = jobCosts._sum.amountCents ?? 0;

  return {
    spentCents,
    expenseCount: spent._count,
    taxCents: spent._sum.taxCents ?? 0,
    jobCostCents,
    jobCostCount: jobCosts._count,
    overheadCents: spentCents - jobCostCents,
    // Not range-scoped: money still owed to a teammate does not stop being
    // owed because the report is showing a different month.
    unreimbursedCents: owed._sum.amountCents ?? 0,
    unreimbursedCount: owed._count,
  };
}

export type ExpenseTotals = Awaited<ReturnType<typeof expenseTotals>>;

/** Where the money went, biggest category first. */
export async function spendByCategory(
  organizationId: string,
  range: DateRange,
  take = 8,
) {
  const rows = await prisma.expense.groupBy({
    by: ["category"],
    where: { organizationId, spentAt: { gte: range.from, lte: range.to } },
    _sum: { amountCents: true },
    _count: true,
    orderBy: { _sum: { amountCents: "desc" } },
    take,
  });

  return rows.map((row) => ({
    category: asStatus(
      EXPENSE_CATEGORIES,
      row.category,
      "OTHER",
    ) as ExpenseCategory,
    label:
      EXPENSE_CATEGORY_LABELS[
        asStatus(EXPENSE_CATEGORIES, row.category, "OTHER") as ExpenseCategory
      ],
    totalCents: row._sum.amountCents ?? 0,
    count: row._count,
  }));
}

/** Who the business pays most. Expenses with no vendor recorded are pooled. */
export async function spendByVendor(
  organizationId: string,
  range: DateRange,
  take = 8,
) {
  const rows = await prisma.expense.groupBy({
    by: ["vendor"],
    where: { organizationId, spentAt: { gte: range.from, lte: range.to } },
    _sum: { amountCents: true },
    _count: true,
    orderBy: { _sum: { amountCents: "desc" } },
    take,
  });

  return rows.map((row) => ({
    vendor: row.vendor ?? "Not recorded",
    totalCents: row._sum.amountCents ?? 0,
    count: row._count,
  }));
}

/** Receivables position — as of now, not the selected range. */
export async function receivablesSnapshot(organizationId: string) {
  const now = new Date();

  const open = await prisma.invoice.findMany({
    where: {
      organizationId,
      status: { in: ["SENT", "VIEWED", "PARTIALLY_PAID", "OVERDUE"] },
      balanceCents: { gt: 0 },
    },
    select: { balanceCents: true, dueDate: true },
  });

  let outstandingCents = 0;
  let overdueCents = 0;
  let overdueCount = 0;

  for (const invoice of open) {
    outstandingCents += invoice.balanceCents;
    if (invoice.dueDate && invoice.dueDate < startOfDay(now)) {
      overdueCents += invoice.balanceCents;
      overdueCount++;
    }
  }

  return {
    outstandingCents,
    overdueCents,
    overdueCount,
    openCount: open.length,
  };
}

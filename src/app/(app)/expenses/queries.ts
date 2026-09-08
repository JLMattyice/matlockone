import "server-only";

import { notFound } from "next/navigation";
import { endOfDay, startOfDay, startOfMonth, startOfYear, subDays } from "date-fns";

import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/constants";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

const PAGE_SIZE = 25;

/** Named spans offered on the list, resolved server-side so the URL stays short. */
export const EXPENSE_PERIODS = ["30d", "90d", "month", "year", "all"] as const;
export type ExpensePeriod = (typeof EXPENSE_PERIODS)[number];

export const EXPENSE_PERIOD_LABELS: Record<ExpensePeriod, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  month: "This month",
  year: "This year",
  all: "All time",
};

export function asExpensePeriod(value: string | undefined): ExpensePeriod {
  return (EXPENSE_PERIODS as readonly string[]).includes(value ?? "")
    ? (value as ExpensePeriod)
    : "90d";
}

function periodStart(period: ExpensePeriod, now = new Date()): Date | null {
  switch (period) {
    case "30d":
      return startOfDay(subDays(now, 29));
    case "90d":
      return startOfDay(subDays(now, 89));
    case "month":
      return startOfMonth(now);
    case "year":
      return startOfYear(now);
    case "all":
      return null;
  }
}

export type ExpenseListParams = {
  organizationId: string;
  q?: string;
  category?: string;
  period?: ExpensePeriod;
  jobId?: string;
  clientId?: string;
  /** "billable" | "reimbursable" | "unreimbursed" */
  flag?: string;
  page?: number;
};

function buildWhere(params: ExpenseListParams): Prisma.ExpenseWhereInput {
  const q = params.q?.trim();
  const from = periodStart(params.period ?? "all");

  return {
    organizationId: params.organizationId,
    ...(params.category ? { category: params.category } : {}),
    ...(params.jobId ? { jobId: params.jobId } : {}),
    ...(params.clientId ? { clientId: params.clientId } : {}),
    ...(from ? { spentAt: { gte: from, lte: endOfDay(new Date()) } } : {}),
    ...(params.flag === "billable" ? { billable: true } : {}),
    ...(params.flag === "reimbursable" ? { reimbursable: true } : {}),
    ...(params.flag === "unreimbursed"
      ? { reimbursable: true, reimbursedAt: null }
      : {}),
    ...(q
      ? {
          OR: [
            { description: { contains: q } },
            { vendor: { contains: q } },
            { reference: { contains: q } },
            { job: { number: { contains: q } } },
            { job: { title: { contains: q } } },
            { client: { displayName: { contains: q } } },
          ],
        }
      : {}),
  };
}

export async function listExpenses(params: ExpenseListParams) {
  const page = Math.max(params.page ?? 1, 1);
  const where = buildWhere(params);

  const [total, rows, sum] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.findMany({
      where,
      orderBy: [{ spentAt: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        job: { select: { id: true, number: true, title: true } },
        client: { select: { id: true, displayName: true } },
        paidBy: { select: { id: true, name: true } },
        _count: { select: { attachments: true } },
      },
    }),
    prisma.expense.aggregate({
      where,
      _sum: { amountCents: true, taxCents: true },
    }),
  ]);

  return {
    rows,
    total,
    totalCents: sum._sum.amountCents ?? 0,
    taxCents: sum._sum.taxCents ?? 0,
    page,
    pageCount: Math.max(Math.ceil(total / PAGE_SIZE), 1),
    pageSize: PAGE_SIZE,
  };
}

export type ExpenseRow = Awaited<ReturnType<typeof listExpenses>>["rows"][number];

/**
 * Where the money went, for the filtered span. Ordered by spend so the biggest
 * line is the first thing read, which is the only ordering anyone wants here.
 */
export async function expenseSummary(params: ExpenseListParams) {
  const where = buildWhere(params);

  const [byCategory, owed] = await Promise.all([
    prisma.expense.groupBy({
      by: ["category"],
      where,
      _count: true,
      _sum: { amountCents: true },
    }),
    prisma.expense.aggregate({
      where: {
        organizationId: params.organizationId,
        reimbursable: true,
        reimbursedAt: null,
      },
      _sum: { amountCents: true },
      _count: true,
    }),
  ]);

  const categories = byCategory
    .map((row) => ({
      category: (EXPENSE_CATEGORIES as readonly string[]).includes(row.category)
        ? (row.category as ExpenseCategory)
        : ("OTHER" as ExpenseCategory),
      count: row._count,
      totalCents: row._sum.amountCents ?? 0,
    }))
    .sort((a, b) => b.totalCents - a.totalCents);

  return {
    categories,
    // Outstanding reimbursements ignore the period filter on purpose: money
    // owed to a teammate does not stop being owed when the date range moves.
    unreimbursedCents: owed._sum.amountCents ?? 0,
    unreimbursedCount: owed._count,
  };
}

export async function getExpense(organizationId: string, id: string) {
  const expense = await prisma.expense.findFirst({
    where: { id, organizationId },
    include: {
      job: { select: { id: true, number: true, title: true } },
      client: { select: { id: true, displayName: true } },
      paidBy: { select: { id: true, name: true } },
      createdBy: { select: { name: true } },
      attachments: {
        orderBy: { createdAt: "desc" },
        include: { uploadedBy: { select: { name: true } } },
      },
      notes: {
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
        include: { author: { select: { name: true } } },
      },
    },
  });

  if (!expense) notFound();
  return expense;
}

export type ExpenseDetail = Awaited<ReturnType<typeof getExpense>>;

/** Jobs an expense can be booked against. Bounded — recent work first. */
export async function jobOptions(organizationId: string) {
  return prisma.job.findMany({
    where: { organizationId, status: { not: "CANCELLED" } },
    orderBy: [{ scheduledStart: "desc" }, { createdAt: "desc" }],
    take: 200,
    select: {
      id: true,
      number: true,
      title: true,
      clientId: true,
      client: { select: { id: true, displayName: true } },
    },
  });
}

export async function clientOptions(organizationId: string) {
  return prisma.client.findMany({
    where: { organizationId, status: { not: "ARCHIVED" } },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true },
  });
}

export async function payerOptions(organizationId: string) {
  return prisma.user.findMany({
    where: { organizationId, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

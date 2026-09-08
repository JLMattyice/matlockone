import "server-only";

import {
  addDays,
  endOfDay,
  endOfMonth,
  startOfDay,
  startOfMonth,
  subMonths,
} from "date-fns";

import type { AppContext } from "@/lib/auth";
import { INVOICE_OPEN_STATUSES } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { can, jobVisibilityWhere } from "@/lib/permissions";

/**
 * Every query here is scoped to `organizationId` and, for employees, further
 * narrowed to their own assigned work. Financial figures are skipped entirely
 * for roles without `invoices:read` rather than being fetched and hidden.
 */
export async function loadDashboard(ctx: AppContext) {
  const orgId = ctx.org.id;
  const now = new Date();
  const scope = { organizationId: orgId };
  const jobScope = { ...scope, ...jobVisibilityWhere(ctx.user) };

  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);
  const seesMoney = can(ctx.user, "invoices:read");
  // A separate permission from invoices, and checked separately — a role that
  // can see what came in does not automatically get to see what went out.
  const seesExpenses = can(ctx.user, "expenses:read");

  const [
    upcoming,
    inProgress,
    completedThisMonth,
    activeClients,
    revenueThisMonth,
    openInvoices,
    overdueInvoices,
    overdueTotals,
    recentPayments,
    revenueRows,
    spentThisMonth,
    expenseRows,
    reimbursementsOwed,
    reimbursementTotals,
  ] = await Promise.all([
    prisma.job.findMany({
      where: {
        ...jobScope,
        status: { in: ["SCHEDULED", "CONFIRMED"] },
        scheduledStart: {
          gte: startOfDay(now),
          lte: endOfDay(addDays(now, 7)),
        },
      },
      orderBy: { scheduledStart: "asc" },
      take: 6,
      include: {
        client: { select: { id: true, displayName: true } },
        address: { select: { line1: true, city: true, state: true } },
        assignments: {
          select: { user: { select: { id: true, name: true } } },
        },
      },
    }),

    prisma.job.findMany({
      where: { ...jobScope, status: "IN_PROGRESS" },
      orderBy: { startedAt: "asc" },
      take: 5,
      include: {
        client: { select: { id: true, displayName: true } },
        assignments: { select: { user: { select: { id: true, name: true } } } },
      },
    }),

    prisma.job.count({
      where: {
        ...jobScope,
        status: "COMPLETED",
        completedAt: { gte: monthStart, lte: monthEnd },
      },
    }),

    prisma.client.count({ where: { ...scope, status: "ACTIVE" } }),

    seesMoney
      ? prisma.payment.aggregate({
          where: { ...scope, receivedAt: { gte: monthStart, lte: monthEnd } },
          _sum: { amountCents: true },
        })
      : null,

    seesMoney
      ? prisma.invoice.aggregate({
          where: { ...scope, status: { in: INVOICE_OPEN_STATUSES } },
          _sum: { balanceCents: true },
          _count: true,
        })
      : null,

    seesMoney
      ? prisma.invoice.findMany({
          where: {
            ...scope,
            status: { in: INVOICE_OPEN_STATUSES },
            dueDate: { lt: startOfDay(now) },
          },
          orderBy: { dueDate: "asc" },
          take: 5,
          include: { client: { select: { id: true, displayName: true } } },
        })
      : [],

    // The list above is capped at 5 for display; the tile needs the real total
    // across every overdue invoice, so it is aggregated separately. Summing
    // the displayed rows understated it badly on a busy ledger.
    seesMoney
      ? prisma.invoice.aggregate({
          where: {
            ...scope,
            status: { in: INVOICE_OPEN_STATUSES },
            balanceCents: { gt: 0 },
            dueDate: { lt: startOfDay(now) },
          },
          _sum: { balanceCents: true },
          _count: true,
        })
      : null,

    seesMoney
      ? prisma.payment.findMany({
          where: scope,
          orderBy: { receivedAt: "desc" },
          take: 5,
          include: {
            client: { select: { id: true, displayName: true } },
            invoice: { select: { id: true, number: true } },
          },
        })
      : [],

    seesMoney
      ? prisma.payment.findMany({
          where: { ...scope, receivedAt: { gte: startOfMonth(subMonths(now, 5)) } },
          select: { amountCents: true, receivedAt: true },
        })
      : [],

    seesExpenses
      ? prisma.expense.aggregate({
          where: { ...scope, spentAt: { gte: monthStart, lte: monthEnd } },
          _sum: { amountCents: true },
          _count: true,
        })
      : null,

    seesExpenses
      ? prisma.expense.findMany({
          where: { ...scope, spentAt: { gte: startOfMonth(subMonths(now, 5)) } },
          select: { amountCents: true, spentAt: true },
        })
      : [],

    // Money the business owes its own people. Not scoped to this month: a
    // debt from March is still a debt in September.
    seesExpenses
      ? prisma.expense.findMany({
          where: { ...scope, reimbursable: true, reimbursedAt: null },
          orderBy: { spentAt: "asc" },
          take: 5,
          include: { paidBy: { select: { id: true, name: true } } },
        })
      : [],

    // The list above is capped for display; the total has to cover every
    // unsettled expense, the same way the overdue tile does.
    seesExpenses
      ? prisma.expense.aggregate({
          where: { ...scope, reimbursable: true, reimbursedAt: null },
          _sum: { amountCents: true },
          _count: true,
        })
      : null,
  ]);

  return {
    seesMoney,
    seesExpenses,
    upcoming,
    inProgress,
    completedThisMonth,
    activeClients,
    revenueThisMonthCents: revenueThisMonth?._sum.amountCents ?? 0,
    outstandingCents: openInvoices?._sum.balanceCents ?? 0,
    outstandingCount: openInvoices?._count ?? 0,
    overdueInvoices,
    overdueCents: overdueTotals?._sum.balanceCents ?? 0,
    overdueCount: overdueTotals?._count ?? 0,
    recentPayments,
    spentThisMonthCents: spentThisMonth?._sum.amountCents ?? 0,
    spentThisMonthCount: spentThisMonth?._count ?? 0,
    reimbursementsOwed,
    reimbursementsOwedCents: reimbursementTotals?._sum.amountCents ?? 0,
    reimbursementsOwedCount: reimbursementTotals?._count ?? 0,
    monthlyCashFlow: bucketByMonth(revenueRows, expenseRows, now, 6),
  };
}

export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;

/**
 * Buckets money in and money out into the trailing `months` calendar months.
 *
 * Both series are bucketed here together rather than by two separate passes,
 * so the bars drawn against each other can never disagree about which month a
 * date belongs to. Done in JS rather than SQL so the grouping does not depend
 * on the database's date functions, which differ between SQLite and Postgres.
 */
function bucketByMonth(
  payments: { amountCents: number; receivedAt: Date }[],
  expenses: { amountCents: number; spentAt: Date }[],
  now: Date,
  months: number,
) {
  const buckets = Array.from({ length: months }, (_, i) => {
    const date = startOfMonth(subMonths(now, months - 1 - i));
    return { date, key: monthKey(date), inCents: 0, outCents: 0 };
  });

  const index = new Map(buckets.map((b) => [b.key, b]));

  for (const row of payments) {
    const bucket = index.get(monthKey(row.receivedAt));
    if (bucket) bucket.inCents += row.amountCents;
  }

  for (const row of expenses) {
    const bucket = index.get(monthKey(row.spentAt));
    if (bucket) bucket.outCents += row.amountCents;
  }

  return buckets;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}`;
}

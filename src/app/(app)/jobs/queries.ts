import "server-only";

import { notFound } from "next/navigation";

import type { AppContext } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { jobVisibilityWhere } from "@/lib/permissions";
import { like } from "@/lib/search";
import type { Prisma } from "@/generated/prisma/client";

export const JOBS_PAGE_SIZE = 25;

export type JobListParams = {
  ctx: AppContext;
  q?: string;
  status?: string;
  kind?: string;
  assignedTo?: string;
  clientId?: string;
  from?: Date;
  to?: Date;
  groupId?: string;
  page?: number;
};

/**
 * Employees see only jobs they are assigned to. That restriction is folded into
 * the `where` via `jobVisibilityWhere` rather than filtered after the fact, so
 * the count, the pagination and the rows all agree.
 */
function buildWhere(params: JobListParams): Prisma.JobWhereInput {
  const q = params.q?.trim();
  const { org, user } = params.ctx;

  return {
    organizationId: org.id,
    ...jobVisibilityWhere(user),
    ...(params.status ? { status: params.status } : {}),
    ...(params.kind ? { kind: params.kind } : {}),
    ...(params.clientId ? { clientId: params.clientId } : {}),
    ...(params.assignedTo
      ? { assignments: { some: { userId: params.assignedTo } } }
      : {}),
    ...(params.groupId ? { groupId: params.groupId } : {}),
    ...(params.from || params.to
      ? {
          scheduledStart: {
            ...(params.from ? { gte: params.from } : {}),
            ...(params.to ? { lte: params.to } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { number: like(q) },
            { title: like(q) },
            { description: like(q) },
            { client: { displayName: like(q) } },
            { address: { line1: like(q) } },
            { address: { city: like(q) } },
          ],
        }
      : {}),
  };
}

export async function listJobs(params: JobListParams) {
  const page = Math.max(params.page ?? 1, 1);
  const where = buildWhere(params);

  const [total, rows] = await Promise.all([
    prisma.job.count({ where }),
    prisma.job.findMany({
      where,
      orderBy: [{ scheduledStart: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * JOBS_PAGE_SIZE,
      take: JOBS_PAGE_SIZE,
      include: {
        client: { select: { id: true, displayName: true } },
        address: { select: { line1: true, city: true, state: true } },
        assignments: {
          select: { user: { select: { id: true, name: true } } },
        },
        recurrenceRule: { select: { id: true } },
      },
    }),
  ]);

  return {
    rows,
    total,
    page,
    pageCount: Math.max(Math.ceil(total / JOBS_PAGE_SIZE), 1),
    pageSize: JOBS_PAGE_SIZE,
  };
}

export type JobListRow = Awaited<ReturnType<typeof listJobs>>["rows"][number];

export async function jobStatusCounts(ctx: AppContext) {
  const rows = await prisma.job.groupBy({
    by: ["status"],
    where: {
      organizationId: ctx.org.id,
      ...jobVisibilityWhere(ctx.user),
    },
    _count: true,
  });
  return new Map(rows.map((row) => [row.status, row._count]));
}

/**
 * A job with everything its detail screen shows. 404s when the id belongs to
 * another organization, or to a job an employee is not assigned to.
 */
export async function getJob(ctx: AppContext, id: string) {
  const job = await prisma.job.findFirst({
    where: {
      id,
      organizationId: ctx.org.id,
      ...jobVisibilityWhere(ctx.user),
    },
    include: {
      client: {
        select: {
          id: true,
          displayName: true,
          email: true,
          phone: true,
          type: true,
        },
      },
      address: true,
      group: { select: { id: true, name: true } },
      createdBy: { select: { name: true } },
      recurrenceRule: true,
      recurrenceParent: { select: { id: true, number: true } },
      assignments: {
        orderBy: { assignedAt: "asc" },
        include: {
          user: { select: { id: true, name: true, position: true, role: true } },
        },
      },
      attachments: {
        orderBy: { createdAt: "desc" },
        include: { uploadedBy: { select: { name: true } } },
      },
      materials: { orderBy: { createdAt: "asc" } },
      timeEntries: {
        orderBy: { startedAt: "desc" },
        include: { user: { select: { id: true, name: true } } },
      },
      notes: {
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
        include: { author: { select: { name: true } } },
      },
      invoices: {
        orderBy: { issueDate: "desc" },
        select: {
          id: true,
          number: true,
          status: true,
          totalCents: true,
          balanceCents: true,
        },
      },
      sourceEstimate: { select: { id: true, number: true, status: true } },
      _count: { select: { recurrenceChildren: true } },
    },
  });

  if (!job) notFound();
  return job;
}

export type JobDetail = Awaited<ReturnType<typeof getJob>>;

/**
 * Billable totals for the job header: materials, labor, expenses, and the sum.
 *
 * `expensesCents` is passed in rather than read off the job, because expenses
 * are only fetched for roles allowed to see them — a role without that
 * permission gets a total of what it can actually account for, not a number
 * with an invisible component in it.
 */
export function jobCostTotals(
  job: {
    materials: { billable: boolean; totalCents: number }[];
    timeEntries: { billable: boolean; minutes: number; hourlyRateCents: number }[];
  },
  expensesCents = 0,
) {
  const materialsCents = job.materials
    .filter((m) => m.billable)
    .reduce((sum, m) => sum + m.totalCents, 0);

  const laborCents = job.timeEntries
    .filter((t) => t.billable)
    .reduce((sum, t) => sum + Math.round((t.minutes / 60) * t.hourlyRateCents), 0);

  const totalMinutes = job.timeEntries.reduce((sum, t) => sum + t.minutes, 0);

  return {
    materialsCents,
    laborCents,
    expensesCents,
    totalCents: materialsCents + laborCents + expensesCents,
    totalMinutes,
  };
}

/**
 * Expenses booked against one job.
 *
 * The rows and the totals come from the same fetch on purpose: a separate
 * aggregate could disagree with the list under it, and a cost figure that does
 * not match the lines it claims to summarise is worse than no figure.
 */
export async function jobExpenses(organizationId: string, jobId: string) {
  const rows = await prisma.expense.findMany({
    where: { organizationId, jobId },
    orderBy: [{ spentAt: "desc" }, { createdAt: "desc" }],
    include: {
      paidBy: { select: { id: true, name: true } },
      _count: { select: { attachments: true } },
    },
  });

  return {
    rows,
    count: rows.length,
    totalCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
    // The slice meant to go back on the client's invoice.
    billableCents: rows
      .filter((row) => row.billable)
      .reduce((sum, row) => sum + row.amountCents, 0),
    unreimbursedCents: rows
      .filter((row) => row.reimbursable && !row.reimbursedAt)
      .reduce((sum, row) => sum + row.amountCents, 0),
  };
}

export type JobExpenses = Awaited<ReturnType<typeof jobExpenses>>;

// ------------------------------------------------------------- scheduling ---

/** Everything scheduled inside a window, for the calendar. */
export async function scheduleEvents(
  ctx: AppContext,
  from: Date,
  to: Date,
  filters: { assignedTo?: string; status?: string; groupId?: string } = {},
) {
  return prisma.job.findMany({
    where: {
      organizationId: ctx.org.id,
      ...jobVisibilityWhere(ctx.user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.assignedTo
        ? { assignments: { some: { userId: filters.assignedTo } } }
        : {}),
      ...(filters.groupId ? { groupId: filters.groupId } : {}),
      scheduledStart: { gte: from, lte: to },
    },
    orderBy: { scheduledStart: "asc" },
    include: {
      client: { select: { id: true, displayName: true } },
      address: { select: { line1: true, city: true } },
      assignments: {
        select: { user: { select: { id: true, name: true } } },
      },
    },
  });
}

export type ScheduleEvent = Awaited<ReturnType<typeof scheduleEvents>>[number];

/** Anything with no date on it yet — shown beside the calendar to be placed. */
export async function unscheduledJobs(ctx: AppContext) {
  return prisma.job.findMany({
    where: {
      organizationId: ctx.org.id,
      ...jobVisibilityWhere(ctx.user),
      scheduledStart: null,
      status: { notIn: ["COMPLETED", "CANCELLED"] },
    },
    orderBy: { createdAt: "desc" },
    take: 25,
    include: {
      client: { select: { id: true, displayName: true } },
      assignments: { select: { user: { select: { id: true, name: true } } } },
    },
  });
}

// ----------------------------------------------------------- form options ---

export async function activeCrew(organizationId: string) {
  return prisma.user.findMany({
    where: { organizationId, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, position: true, role: true },
  });
}

/** Client picker options. Bounded — a type-ahead replaces this if it ever grows. */
export async function clientOptions(organizationId: string) {
  return prisma.client.findMany({
    where: { organizationId, status: { not: "ARCHIVED" } },
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      displayName: true,
      addresses: {
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: {
          id: true,
          label: true,
          line1: true,
          city: true,
          state: true,
          postalCode: true,
          isPrimary: true,
        },
      },
    },
  });
}

export type ClientOption = Awaited<ReturnType<typeof clientOptions>>[number];

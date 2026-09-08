import "server-only";

import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";
import { ageingBucket } from "@/lib/documents";
import type { Prisma } from "@/generated/prisma/client";

export const INVOICES_PAGE_SIZE = 25;

/** Statuses stored on the row for an invoice that still owes money. */
const OPEN_STORED_STATUSES = ["SENT", "VIEWED", "PARTIALLY_PAID", "OVERDUE"];

export type InvoiceListParams = {
  organizationId: string;
  q?: string;
  status?: string;
  clientId?: string;
  page?: number;
};

/**
 * PARTIALLY_PAID and OVERDUE are derived rather than stored, so filtering on
 * them means matching the underlying facts — a part-payment, or a due date that
 * has passed — not a status string.
 */
function buildWhere(params: InvoiceListParams): Prisma.InvoiceWhereInput {
  const q = params.q?.trim();
  const now = new Date();

  let statusWhere: Prisma.InvoiceWhereInput = {};

  if (params.status === "OVERDUE") {
    statusWhere = {
      status: { in: OPEN_STORED_STATUSES },
      balanceCents: { gt: 0 },
      dueDate: { lt: now },
    };
  } else if (params.status === "PARTIALLY_PAID") {
    statusWhere = {
      status: { in: OPEN_STORED_STATUSES },
      amountPaidCents: { gt: 0 },
      balanceCents: { gt: 0 },
    };
  } else if (params.status === "PAID") {
    statusWhere = { status: { notIn: ["DRAFT", "CANCELLED"] }, balanceCents: { lte: 0 } };
  } else if (params.status === "SENT" || params.status === "VIEWED") {
    statusWhere = {
      status: params.status,
      balanceCents: { gt: 0 },
      OR: [{ dueDate: null }, { dueDate: { gte: now } }],
    };
  } else if (params.status) {
    statusWhere = { status: params.status };
  }

  return {
    organizationId: params.organizationId,
    ...(params.clientId ? { clientId: params.clientId } : {}),
    ...statusWhere,
    ...(q
      ? {
          AND: [
            {
              OR: [
                { number: { contains: q } },
                { title: { contains: q } },
                { client: { displayName: { contains: q } } },
                { job: { number: { contains: q } } },
                { lineItems: { some: { name: { contains: q } } } },
              ],
            },
          ],
        }
      : {}),
  };
}

export async function listInvoices(params: InvoiceListParams) {
  const page = Math.max(params.page ?? 1, 1);
  const where = buildWhere(params);

  const [total, rows] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * INVOICES_PAGE_SIZE,
      take: INVOICES_PAGE_SIZE,
      include: {
        client: { select: { id: true, displayName: true } },
        job: { select: { id: true, number: true } },
        _count: { select: { payments: true } },
      },
    }),
  ]);

  return {
    rows,
    total,
    page,
    pageCount: Math.max(Math.ceil(total / INVOICES_PAGE_SIZE), 1),
    pageSize: INVOICES_PAGE_SIZE,
  };
}

export type InvoiceListRow = Awaited<ReturnType<typeof listInvoices>>["rows"][number];

/**
 * Receivables headline plus an ageing breakdown.
 *
 * The buckets are computed in JS over the open invoices rather than in SQL,
 * because "days past due" is relative to now and the same expression would have
 * to be written differently for SQLite and Postgres.
 */
export async function invoiceSummary(organizationId: string) {
  const now = new Date();

  const [open, paidThisMonth, draftCount, cancelledCount] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        organizationId,
        status: { in: OPEN_STORED_STATUSES },
        balanceCents: { gt: 0 },
      },
      select: { balanceCents: true, dueDate: true },
    }),
    prisma.payment.aggregate({
      where: {
        organizationId,
        receivedAt: {
          gte: new Date(now.getFullYear(), now.getMonth(), 1),
        },
      },
      _sum: { amountCents: true },
    }),
    prisma.invoice.count({ where: { organizationId, status: "DRAFT" } }),
    prisma.invoice.count({ where: { organizationId, status: "CANCELLED" } }),
  ]);

  const buckets = { current: 0, "1-30": 0, "31-60": 0, "60+": 0 };
  let outstandingCents = 0;
  let overdueCents = 0;
  let overdueCount = 0;

  for (const invoice of open) {
    outstandingCents += invoice.balanceCents;
    const bucket = ageingBucket(invoice.dueDate);
    buckets[bucket] += invoice.balanceCents;
    if (bucket !== "current") {
      overdueCents += invoice.balanceCents;
      overdueCount++;
    }
  }

  return {
    openCount: open.length,
    outstandingCents,
    overdueCents,
    overdueCount,
    collectedThisMonthCents: paidThisMonth._sum.amountCents ?? 0,
    draftCount,
    cancelledCount,
    buckets,
  };
}

export async function getInvoice(organizationId: string, id: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId },
    include: {
      client: {
        select: { id: true, displayName: true, email: true, phone: true },
      },
      address: true,
      job: { select: { id: true, number: true, title: true, status: true } },
      estimate: { select: { id: true, number: true } },
      createdBy: { select: { name: true } },
      lineItems: { orderBy: { sortOrder: "asc" } },
      payments: {
        orderBy: { receivedAt: "desc" },
        include: { recordedBy: { select: { name: true } } },
      },
      notes_: {
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
        include: { author: { select: { name: true } } },
      },
    },
  });

  if (!invoice) notFound();
  return invoice;
}

export type InvoiceDetail = Awaited<ReturnType<typeof getInvoice>>;

/** The public view, addressed only by its unguessable token. */
export async function getInvoiceByToken(token: string) {
  return prisma.invoice.findUnique({
    where: { publicToken: token },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      issueDate: true,
      dueDate: true,
      viewedAt: true,
      subtotalCents: true,
      discountCents: true,
      taxRateBp: true,
      taxCents: true,
      totalCents: true,
      amountPaidCents: true,
      balanceCents: true,
      notes: true,
      terms: true,
      // The pay link only. paymentRef and paymentProvider stay internal —
      // this select is what a public, unauthenticated page renders.
      paymentUrl: true,
      lineItems: { orderBy: { sortOrder: "asc" } },
      payments: {
        orderBy: { receivedAt: "desc" },
        select: {
          id: true,
          amountCents: true,
          method: true,
          receivedAt: true,
        },
      },
      client: { select: { displayName: true } },
      address: {
        select: {
          line1: true,
          line2: true,
          city: true,
          state: true,
          postalCode: true,
        },
      },
      organization: {
        select: {
          name: true,
          legalName: true,
          email: true,
          phone: true,
          website: true,
          logoUrl: true,
          primaryColor: true,
          accentColor: true,
          currency: true,
          locale: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          postalCode: true,
          invoiceFooter: true,
        },
      },
    },
  });
}

// --------------------------------------------------------------- payments ---

export const PAYMENTS_PAGE_SIZE = 50;

export async function listPayments(params: {
  organizationId: string;
  q?: string;
  method?: string;
  clientId?: string;
  page?: number;
}) {
  const page = Math.max(params.page ?? 1, 1);
  const q = params.q?.trim();

  const where: Prisma.PaymentWhereInput = {
    organizationId: params.organizationId,
    ...(params.method ? { method: params.method } : {}),
    ...(params.clientId ? { clientId: params.clientId } : {}),
    ...(q
      ? {
          OR: [
            { reference: { contains: q } },
            { notes: { contains: q } },
            { invoice: { number: { contains: q } } },
            { client: { displayName: { contains: q } } },
          ],
        }
      : {}),
  };

  const [total, rows, sum] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * PAYMENTS_PAGE_SIZE,
      take: PAYMENTS_PAGE_SIZE,
      include: {
        client: { select: { id: true, displayName: true } },
        invoice: { select: { id: true, number: true } },
        recordedBy: { select: { name: true } },
      },
    }),
    prisma.payment.aggregate({ where, _sum: { amountCents: true } }),
  ]);

  return {
    rows,
    total,
    totalCents: sum._sum.amountCents ?? 0,
    page,
    pageCount: Math.max(Math.ceil(total / PAYMENTS_PAGE_SIZE), 1),
    pageSize: PAYMENTS_PAGE_SIZE,
  };
}

/** Completed jobs that have not been billed yet. */
export async function billableJobs(organizationId: string) {
  return prisma.job.findMany({
    where: {
      organizationId,
      status: "COMPLETED",
      invoices: { none: {} },
    },
    orderBy: { completedAt: "desc" },
    take: 50,
    include: {
      client: { select: { id: true, displayName: true } },
      materials: true,
      timeEntries: true,
      _count: { select: { materials: true, timeEntries: true } },
    },
  });
}

export async function invoiceClientOptions(organizationId: string) {
  return prisma.client.findMany({
    where: { organizationId, status: { not: "ARCHIVED" } },
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      displayName: true,
      email: true,
      taxExempt: true,
      addresses: {
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: {
          id: true,
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

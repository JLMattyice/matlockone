import "server-only";

import { notFound } from "next/navigation";

import { INVOICE_OPEN_STATUSES } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { like } from "@/lib/search";
import type { Prisma } from "@/generated/prisma/client";

export const CLIENTS_PAGE_SIZE = 25;

export type ClientSort = "name" | "newest" | "activity";

export type ClientListParams = {
  organizationId: string;
  q?: string;
  status?: string;
  type?: string;
  sort?: ClientSort;
  page?: number;
};

/**
 * One page of the client database, with the aggregates the list actually shows.
 *
 * Three queries regardless of page size: the page itself, outstanding balances
 * grouped over the page's ids, and the last completed job per client. Doing the
 * aggregates per row would mean 3 x pageSize round trips.
 */
export async function listClients(params: ClientListParams) {
  const page = Math.max(params.page ?? 1, 1);
  const q = params.q?.trim();

  const where: Prisma.ClientWhereInput = {
    organizationId: params.organizationId,
    ...(params.status ? { status: params.status } : {}),
    ...(params.type ? { type: params.type } : {}),
    // `like()` rather than a bare `contains`: the two databases disagree about
    // case, and src/lib/search.ts is where that is settled.
    ...(q
      ? {
          OR: [
            { displayName: like(q) },
            { businessName: like(q) },
            { firstName: like(q) },
            { lastName: like(q) },
            { email: like(q) },
            { phone: like(q) },
            { mobilePhone: like(q) },
            { addresses: { some: { line1: like(q) } } },
            { addresses: { some: { city: like(q) } } },
            { addresses: { some: { postalCode: like(q) } } },
          ],
        }
      : {}),
  };

  const orderBy: Prisma.ClientOrderByWithRelationInput =
    params.sort === "newest"
      ? { createdAt: "desc" }
      : params.sort === "activity"
        ? { updatedAt: "desc" }
        : { displayName: "asc" };

  const [total, rows] = await Promise.all([
    prisma.client.count({ where }),
    prisma.client.findMany({
      where,
      orderBy,
      skip: (page - 1) * CLIENTS_PAGE_SIZE,
      take: CLIENTS_PAGE_SIZE,
      include: {
        addresses: {
          where: { isPrimary: true },
          take: 1,
          select: { line1: true, city: true, state: true, postalCode: true },
        },
        _count: { select: { jobs: true, estimates: true, invoices: true } },
      },
    }),
  ]);

  const ids = rows.map((row) => row.id);

  const [balances, lastJobs] = await Promise.all([
    ids.length
      ? prisma.invoice.groupBy({
          by: ["clientId"],
          where: { clientId: { in: ids }, status: { in: INVOICE_OPEN_STATUSES } },
          _sum: { balanceCents: true },
        })
      : [],
    ids.length
      ? prisma.job.groupBy({
          by: ["clientId"],
          where: { clientId: { in: ids }, status: "COMPLETED" },
          _max: { completedAt: true },
        })
      : [],
  ]);

  const balanceByClient = new Map(
    balances.map((row) => [row.clientId, row._sum.balanceCents ?? 0]),
  );
  const lastJobByClient = new Map(
    lastJobs.map((row) => [row.clientId, row._max.completedAt]),
  );

  return {
    rows: rows.map((row) => ({
      ...row,
      outstandingCents: balanceByClient.get(row.id) ?? 0,
      lastJobAt: lastJobByClient.get(row.id) ?? null,
    })),
    total,
    page,
    pageCount: Math.max(Math.ceil(total / CLIENTS_PAGE_SIZE), 1),
    pageSize: CLIENTS_PAGE_SIZE,
  };
}

export type ClientListRow = Awaited<ReturnType<typeof listClients>>["rows"][number];

/** Counts shown on the status filter chips above the list. */
export async function clientStatusCounts(organizationId: string) {
  const rows = await prisma.client.groupBy({
    by: ["status"],
    where: { organizationId },
    _count: true,
  });
  return new Map(rows.map((row) => [row.status, row._count]));
}

/**
 * A single client with its addresses. 404s when the id belongs to another
 * organization, so the response cannot confirm that the id exists elsewhere.
 */
export async function getClient(organizationId: string, id: string) {
  const client = await prisma.client.findFirst({
    where: { id, organizationId },
    include: {
      addresses: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      createdBy: { select: { name: true } },
      _count: {
        select: {
          jobs: true,
          estimates: true,
          invoices: true,
          payments: true,
          notes: true,
          attachments: true,
        },
      },
    },
  });

  if (!client) notFound();
  return client;
}

export type ClientDetail = Awaited<ReturnType<typeof getClient>>;

/** Financial summary for the client header: billed, paid, still owed. */
export async function clientFinancials(organizationId: string, clientId: string) {
  const [invoiced, paid, open] = await Promise.all([
    prisma.invoice.aggregate({
      where: { organizationId, clientId, status: { not: "CANCELLED" } },
      _sum: { totalCents: true },
    }),
    prisma.payment.aggregate({
      where: { organizationId, clientId },
      _sum: { amountCents: true },
    }),
    prisma.invoice.aggregate({
      where: { organizationId, clientId, status: { in: INVOICE_OPEN_STATUSES } },
      _sum: { balanceCents: true },
      _count: true,
    }),
  ]);

  return {
    invoicedCents: invoiced._sum.totalCents ?? 0,
    paidCents: paid._sum.amountCents ?? 0,
    outstandingCents: open._sum.balanceCents ?? 0,
    openInvoiceCount: open._count,
  };
}

export async function clientJobs(
  organizationId: string,
  clientId: string,
  opts: { take?: number; upcomingOnly?: boolean } = {},
) {
  return prisma.job.findMany({
    where: {
      organizationId,
      clientId,
      ...(opts.upcomingOnly
        ? {
            status: { in: ["SCHEDULED", "CONFIRMED", "IN_PROGRESS"] },
            scheduledStart: { gte: new Date() },
          }
        : {}),
    },
    orderBy: opts.upcomingOnly
      ? { scheduledStart: "asc" }
      : [{ scheduledStart: "desc" }, { createdAt: "desc" }],
    take: opts.take,
    include: {
      address: { select: { line1: true, city: true } },
      assignments: { select: { user: { select: { id: true, name: true } } } },
    },
  });
}

export async function clientEstimates(
  organizationId: string,
  clientId: string,
  take?: number,
) {
  return prisma.estimate.findMany({
    where: { organizationId, clientId },
    orderBy: { issueDate: "desc" },
    take,
  });
}

export async function clientInvoices(
  organizationId: string,
  clientId: string,
  take?: number,
) {
  return prisma.invoice.findMany({
    where: { organizationId, clientId },
    orderBy: { issueDate: "desc" },
    take,
  });
}

export async function clientPayments(
  organizationId: string,
  clientId: string,
  take?: number,
) {
  return prisma.payment.findMany({
    where: { organizationId, clientId },
    orderBy: { receivedAt: "desc" },
    take,
    include: { invoice: { select: { id: true, number: true } } },
  });
}

export async function clientAttachments(
  organizationId: string,
  clientId: string,
) {
  return prisma.attachment.findMany({
    where: { organizationId, clientId },
    orderBy: { createdAt: "desc" },
    include: { uploadedBy: { select: { name: true } } },
  });
}

export async function clientNotes(organizationId: string, clientId: string) {
  return prisma.note.findMany({
    where: { organizationId, clientId },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    include: { author: { select: { name: true } } },
  });
}

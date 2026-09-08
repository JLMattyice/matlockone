import "server-only";

import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

export const ESTIMATES_PAGE_SIZE = 25;

export type EstimateListParams = {
  organizationId: string;
  q?: string;
  status?: string;
  clientId?: string;
  page?: number;
};

function buildWhere(params: EstimateListParams): Prisma.EstimateWhereInput {
  const q = params.q?.trim();
  const now = new Date();

  // EXPIRED is derived from the clock, not stored, so filtering on it means
  // "still open but past its date" rather than a status match.
  const statusWhere: Prisma.EstimateWhereInput =
    params.status === "EXPIRED"
      ? { status: { in: ["SENT", "VIEWED"] }, expiresAt: { lt: now } }
      : params.status === "SENT" || params.status === "VIEWED"
        ? {
            status: params.status,
            OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
          }
        : params.status
          ? { status: params.status }
          : {};

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
                { notes: { contains: q } },
                { client: { displayName: { contains: q } } },
                { lineItems: { some: { name: { contains: q } } } },
              ],
            },
          ],
        }
      : {}),
  };
}

export async function listEstimates(params: EstimateListParams) {
  const page = Math.max(params.page ?? 1, 1);
  const where = buildWhere(params);

  const [total, rows] = await Promise.all([
    prisma.estimate.count({ where }),
    prisma.estimate.findMany({
      where,
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * ESTIMATES_PAGE_SIZE,
      take: ESTIMATES_PAGE_SIZE,
      include: {
        client: { select: { id: true, displayName: true } },
        convertedJob: { select: { id: true, number: true } },
        _count: { select: { lineItems: true } },
      },
    }),
  ]);

  return {
    rows,
    total,
    page,
    pageCount: Math.max(Math.ceil(total / ESTIMATES_PAGE_SIZE), 1),
    pageSize: ESTIMATES_PAGE_SIZE,
  };
}

export type EstimateListRow = Awaited<
  ReturnType<typeof listEstimates>
>["rows"][number];

/** Headline figures above the list: what is out, and what has been won. */
export async function estimateSummary(organizationId: string) {
  const now = new Date();

  const [pending, accepted, draft, byStatus] = await Promise.all([
    prisma.estimate.aggregate({
      where: {
        organizationId,
        status: { in: ["SENT", "VIEWED"] },
        OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
      },
      _sum: { totalCents: true },
      _count: true,
    }),
    prisma.estimate.aggregate({
      where: { organizationId, status: "ACCEPTED" },
      _sum: { totalCents: true },
      _count: true,
    }),
    prisma.estimate.count({ where: { organizationId, status: "DRAFT" } }),
    prisma.estimate.groupBy({
      by: ["status"],
      where: { organizationId },
      _count: true,
    }),
  ]);

  const counts = new Map(byStatus.map((row) => [row.status, row._count]));
  const decided =
    (counts.get("ACCEPTED") ?? 0) + (counts.get("DECLINED") ?? 0);

  return {
    counts,
    pendingCount: pending._count,
    pendingCents: pending._sum.totalCents ?? 0,
    acceptedCount: accepted._count,
    acceptedCents: accepted._sum.totalCents ?? 0,
    draftCount: draft,
    // Only decided estimates count toward the rate; still-open ones would
    // drag it down for no reason.
    acceptanceRate: decided > 0 ? (counts.get("ACCEPTED") ?? 0) / decided : null,
  };
}

export async function getEstimate(organizationId: string, id: string) {
  const estimate = await prisma.estimate.findFirst({
    where: { id, organizationId },
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
      createdBy: { select: { name: true } },
      lineItems: { orderBy: { sortOrder: "asc" } },
      convertedJob: {
        select: { id: true, number: true, status: true, scheduledStart: true },
      },
      invoices: { select: { id: true, number: true, status: true } },
      notes_: {
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
        include: { author: { select: { name: true } } },
      },
    },
  });

  if (!estimate) notFound();
  return estimate;
}

export type EstimateDetail = Awaited<ReturnType<typeof getEstimate>>;

/**
 * The client-facing view, addressed only by its unguessable token. No
 * organization scoping is possible here — the token *is* the credential — so
 * this selects exactly the fields the public page needs and nothing else.
 */
export async function getEstimateByToken(token: string) {
  return prisma.estimate.findUnique({
    where: { publicToken: token },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      issueDate: true,
      expiresAt: true,
      viewedAt: true,
      acceptedAt: true,
      declinedAt: true,
      subtotalCents: true,
      discountType: true,
      discountCents: true,
      taxRateBp: true,
      taxCents: true,
      totalCents: true,
      notes: true,
      terms: true,
      publicToken: true,
      lineItems: { orderBy: { sortOrder: "asc" } },
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
          estimateFooter: true,
        },
      },
    },
  });
}

export type PublicEstimate = NonNullable<
  Awaited<ReturnType<typeof getEstimateByToken>>
>;

/** Price-book entries offered as one-click line items. */
export async function priceBook(organizationId: string) {
  return prisma.priceBookItem.findMany({
    where: { organizationId, isActive: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
    select: {
      id: true,
      kind: true,
      name: true,
      description: true,
      unit: true,
      unitPriceCents: true,
      taxable: true,
    },
  });
}

export type PriceBookEntry = Awaited<ReturnType<typeof priceBook>>[number];

export async function estimateClientOptions(organizationId: string) {
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

export type EstimateClientOption = Awaited<
  ReturnType<typeof estimateClientOptions>
>[number];

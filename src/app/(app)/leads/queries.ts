import "server-only";

import { notFound } from "next/navigation";

import { LEAD_STATUSES, type LeadStatus } from "@/lib/constants";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/** The board renders every open lead at once; this caps a runaway pipeline. */
export const LEAD_BOARD_LIMIT = 300;

export type LeadListParams = {
  organizationId: string;
  q?: string;
  status?: string;
  source?: string;
  assignedTo?: string;
};

function buildWhere(params: LeadListParams): Prisma.LeadWhereInput {
  const q = params.q?.trim();

  return {
    organizationId: params.organizationId,
    ...(params.status ? { status: params.status } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.assignedTo ? { assignedToId: params.assignedTo } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q } },
            { businessName: { contains: q } },
            { email: { contains: q } },
            { phone: { contains: q } },
          ],
        }
      : {}),
  };
}

export async function listLeads(params: LeadListParams) {
  return prisma.lead.findMany({
    where: buildWhere(params),
    orderBy: [{ createdAt: "desc" }],
    take: LEAD_BOARD_LIMIT,
    include: {
      assignedTo: { select: { id: true, name: true } },
      client: { select: { id: true, displayName: true } },
      _count: { select: { notes: true } },
    },
  });
}

export type LeadRow = Awaited<ReturnType<typeof listLeads>>[number];

/** Board columns in pipeline order, each with its own leads and value total. */
export function groupByStatus(leads: LeadRow[]) {
  const columns = new Map<LeadStatus, LeadRow[]>(
    LEAD_STATUSES.map((status) => [status, []]),
  );

  for (const lead of leads) {
    const status = LEAD_STATUSES.includes(lead.status as LeadStatus)
      ? (lead.status as LeadStatus)
      : "NEW";
    columns.get(status)!.push(lead);
  }

  return LEAD_STATUSES.map((status) => {
    const rows = columns.get(status)!;
    return {
      status,
      leads: rows,
      valueCents: rows.reduce(
        (sum, lead) => sum + (lead.estimatedValueCents ?? 0),
        0,
      ),
    };
  });
}

export async function leadPipelineSummary(organizationId: string) {
  const rows = await prisma.lead.groupBy({
    by: ["status"],
    where: { organizationId },
    _count: true,
    _sum: { estimatedValueCents: true },
  });

  const byStatus = new Map(
    rows.map((row) => [
      row.status,
      { count: row._count, valueCents: row._sum.estimatedValueCents ?? 0 },
    ]),
  );

  const open = (["NEW", "CONTACTED", "QUALIFIED", "ESTIMATE_SENT"] as const).reduce(
    (acc, status) => {
      const entry = byStatus.get(status);
      return {
        count: acc.count + (entry?.count ?? 0),
        valueCents: acc.valueCents + (entry?.valueCents ?? 0),
      };
    },
    { count: 0, valueCents: 0 },
  );

  const won = byStatus.get("WON") ?? { count: 0, valueCents: 0 };
  const lost = byStatus.get("LOST") ?? { count: 0, valueCents: 0 };
  const decided = won.count + lost.count;

  return {
    byStatus,
    openCount: open.count,
    openValueCents: open.valueCents,
    wonCount: won.count,
    wonValueCents: won.valueCents,
    lostCount: lost.count,
    // Win rate only counts leads that actually reached a decision — including
    // still-open leads in the denominator would understate it.
    winRate: decided > 0 ? won.count / decided : null,
  };
}

export async function getLead(organizationId: string, id: string) {
  const lead = await prisma.lead.findFirst({
    where: { id, organizationId },
    include: {
      assignedTo: { select: { id: true, name: true } },
      createdBy: { select: { name: true } },
      client: { select: { id: true, displayName: true } },
      notes: {
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
        include: { author: { select: { name: true } } },
      },
    },
  });

  if (!lead) notFound();
  return lead;
}

export type LeadDetail = Awaited<ReturnType<typeof getLead>>;

/** Team members a lead can be assigned to. */
export async function assignableUsers(organizationId: string) {
  return prisma.user.findMany({
    where: { organizationId, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true },
  });
}

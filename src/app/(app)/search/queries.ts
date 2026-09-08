import "server-only";

import type { AppContext } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can, jobVisibilityWhere } from "@/lib/permissions";

export type SearchHit = {
  id: string;
  kind: "client" | "lead" | "job" | "estimate" | "invoice";
  title: string;
  subtitle: string | null;
  meta: string | null;
  href: string;
};

export type SearchResults = {
  groups: { kind: SearchHit["kind"]; label: string; hits: SearchHit[] }[];
  total: number;
};

const PER_KIND = 6;

/**
 * One search across every record type the caller is allowed to see.
 *
 * Each branch is gated on the same permission that guards its module, and jobs
 * are additionally narrowed by `jobVisibilityWhere`, so an employee searching
 * "Beaumont" cannot surface a colleague's job through the search box that the
 * jobs list would have hidden from them.
 */
export async function globalSearch(
  ctx: AppContext,
  rawQuery: string,
): Promise<SearchResults> {
  const q = rawQuery.trim();
  if (q.length < 2) return { groups: [], total: 0 };

  const { org, user } = ctx;
  const scope = { organizationId: org.id };

  const [clients, leads, jobs, estimates, invoices] = await Promise.all([
    can(user, "clients:read")
      ? prisma.client.findMany({
          where: {
            ...scope,
            OR: [
              { displayName: { contains: q } },
              { businessName: { contains: q } },
              { email: { contains: q } },
              { phone: { contains: q } },
              { addresses: { some: { line1: { contains: q } } } },
              { addresses: { some: { city: { contains: q } } } },
            ],
          },
          take: PER_KIND,
          orderBy: { displayName: "asc" },
          select: {
            id: true,
            displayName: true,
            email: true,
            phone: true,
            status: true,
          },
        })
      : [],

    can(user, "leads:read")
      ? prisma.lead.findMany({
          where: {
            ...scope,
            OR: [
              { name: { contains: q } },
              { businessName: { contains: q } },
              { email: { contains: q } },
              { phone: { contains: q } },
            ],
          },
          take: PER_KIND,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            businessName: true,
            status: true,
            email: true,
          },
        })
      : [],

    can(user, "jobs:read")
      ? prisma.job.findMany({
          where: {
            ...scope,
            ...jobVisibilityWhere(user),
            OR: [
              { number: { contains: q } },
              { title: { contains: q } },
              { description: { contains: q } },
              { client: { displayName: { contains: q } } },
              { address: { line1: { contains: q } } },
            ],
          },
          take: PER_KIND,
          orderBy: { scheduledStart: "desc" },
          select: {
            id: true,
            number: true,
            title: true,
            status: true,
            scheduledStart: true,
            client: { select: { displayName: true } },
          },
        })
      : [],

    can(user, "estimates:read")
      ? prisma.estimate.findMany({
          where: {
            ...scope,
            OR: [
              { number: { contains: q } },
              { title: { contains: q } },
              { client: { displayName: { contains: q } } },
              { lineItems: { some: { name: { contains: q } } } },
            ],
          },
          take: PER_KIND,
          orderBy: { issueDate: "desc" },
          select: {
            id: true,
            number: true,
            title: true,
            status: true,
            totalCents: true,
            client: { select: { displayName: true } },
          },
        })
      : [],

    can(user, "invoices:read")
      ? prisma.invoice.findMany({
          where: {
            ...scope,
            OR: [
              { number: { contains: q } },
              { title: { contains: q } },
              { client: { displayName: { contains: q } } },
              { lineItems: { some: { name: { contains: q } } } },
            ],
          },
          take: PER_KIND,
          orderBy: { issueDate: "desc" },
          select: {
            id: true,
            number: true,
            title: true,
            status: true,
            totalCents: true,
            balanceCents: true,
            client: { select: { displayName: true } },
          },
        })
      : [],
  ]);

  const money = (cents: number) =>
    new Intl.NumberFormat(org.locale, {
      style: "currency",
      currency: org.currency,
    }).format(cents / 100);

  const groups: SearchResults["groups"] = [];

  if (clients.length) {
    groups.push({
      kind: "client",
      label: org.labelClientPlural,
      hits: clients.map((c) => ({
        id: c.id,
        kind: "client" as const,
        title: c.displayName,
        subtitle: c.email ?? c.phone,
        meta: c.status === "ACTIVE" ? null : c.status.toLowerCase(),
        href: `/clients/${c.id}`,
      })),
    });
  }

  if (jobs.length) {
    groups.push({
      kind: "job",
      label: org.labelJobPlural,
      hits: jobs.map((j) => ({
        id: j.id,
        kind: "job" as const,
        title: `${j.number} · ${j.title}`,
        subtitle: j.client?.displayName ?? null,
        meta: j.scheduledStart
          ? j.scheduledStart.toLocaleDateString(org.locale)
          : "unscheduled",
        href: `/jobs/${j.id}`,
      })),
    });
  }

  if (estimates.length) {
    groups.push({
      kind: "estimate",
      label: "Estimates",
      hits: estimates.map((e) => ({
        id: e.id,
        kind: "estimate" as const,
        title: `${e.number}${e.title ? ` · ${e.title}` : ""}`,
        subtitle: e.client.displayName,
        meta: money(e.totalCents),
        href: `/estimates/${e.id}`,
      })),
    });
  }

  if (invoices.length) {
    groups.push({
      kind: "invoice",
      label: "Invoices",
      hits: invoices.map((i) => ({
        id: i.id,
        kind: "invoice" as const,
        title: `${i.number}${i.title ? ` · ${i.title}` : ""}`,
        subtitle: i.client.displayName,
        meta:
          i.balanceCents > 0
            ? `${money(i.balanceCents)} due`
            : money(i.totalCents),
        href: `/invoices/${i.id}`,
      })),
    });
  }

  if (leads.length) {
    groups.push({
      kind: "lead",
      label: "Leads",
      hits: leads.map((l) => ({
        id: l.id,
        kind: "lead" as const,
        title: l.name,
        subtitle: l.businessName ?? l.email,
        meta: l.status.replace("_", " ").toLowerCase(),
        href: `/leads/${l.id}`,
      })),
    });
  }

  return {
    groups,
    total: groups.reduce((sum, group) => sum + group.hits.length, 0),
  };
}

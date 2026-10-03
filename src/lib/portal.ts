import "server-only";

import { randomBytes } from "node:crypto";

import { prisma } from "./db";
import { effectiveEstimateStatus, effectiveInvoiceStatus } from "./documents";
import { publicUrl } from "./messaging";

/**
 * The customer portal: one private page per customer with their upcoming
 * visits, past work, estimates to answer, invoices to pay and a way to ask
 * for more.
 *
 * The owner chose a private link over a sign-in: no password to forget, and
 * it works like the estimate and invoice links customers already get. So the
 * token is the whole credential — 192 bits from the system's random source,
 * the same strength as a share link — and the page is guarded the same way,
 * by the limit on links that do not exist.
 *
 * The token is made the first time it is needed (an email that carries it,
 * the office copying it) rather than for every customer up front.
 */

function newPortalToken() {
  return randomBytes(24).toString("base64url");
}

/** The customer's portal token, made now if they have none. */
export async function ensurePortalToken(clientId: string): Promise<string | null> {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { portalToken: true } });
  if (!client) return null;
  if (client.portalToken) return client.portalToken;

  // Only set where still empty, so two sends at once agree on one token.
  await prisma.client.updateMany({
    where: { id: clientId, portalToken: null },
    data: { portalToken: newPortalToken() },
  });
  const made = await prisma.client.findUnique({ where: { id: clientId }, select: { portalToken: true } });
  return made?.portalToken ?? null;
}

/** A new link for the customer; the old one stops working at once. */
export async function replacePortalToken(organizationId: string, clientId: string) {
  await prisma.client.updateMany({
    where: { id: clientId, organizationId },
    data: { portalToken: newPortalToken() },
  });
}

export function portalUrl(token: string) {
  return publicUrl(`/portal/${token}`);
}

/** The line an estimate or invoice email carries, when the customer has a portal. */
export async function portalLine(clientId: string): Promise<string[]> {
  const token = await ensurePortalToken(clientId);
  return token ? [`Everything with us in one place: ${portalUrl(token)}`, ""] : [];
}

const OPEN_JOB_STATUSES = ["SCHEDULED", "CONFIRMED", "IN_PROGRESS"];

/** Everything the portal page shows, or null for a token that is not a customer's. */
export async function portalView(token: string, now = new Date()) {
  if (!token || token.length < 20) return null;

  const client = await prisma.client.findUnique({
    where: { portalToken: token },
    select: {
      id: true,
      displayName: true,
      firstName: true,
      email: true,
      phone: true,
      status: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          email: true,
          phone: true,
          website: true,
          logoUrl: true,
          primaryColor: true,
          currency: true,
          locale: true,
          timeZone: true,
          isDemo: true,
          requestsEnabled: true,
          labelJobSingular: true,
          labelJobPlural: true,
          labelEstimatePlural: true,
        },
      },
    },
  });
  if (!client || client.status === "ARCHIVED") return null;

  const [jobs, estimates, invoices] = await Promise.all([
    prisma.job.findMany({
      where: { clientId: client.id, status: { not: "CANCELLED" } },
      select: {
        id: true,
        title: true,
        status: true,
        scheduledStart: true,
        scheduledEnd: true,
        allDay: true,
        completedAt: true,
        address: { select: { line1: true, city: true } },
      },
      orderBy: { scheduledStart: "asc" },
      take: 200,
    }),
    prisma.estimate.findMany({
      where: { clientId: client.id, status: { not: "DRAFT" } },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        expiresAt: true,
        totalCents: true,
        publicToken: true,
        issueDate: true,
      },
      orderBy: { issueDate: "desc" },
      take: 50,
    }),
    prisma.invoice.findMany({
      where: { clientId: client.id, status: { notIn: ["DRAFT", "CANCELLED"] } },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        dueDate: true,
        issueDate: true,
        paidAt: true,
        totalCents: true,
        amountPaidCents: true,
        balanceCents: true,
        publicToken: true,
      },
      orderBy: { issueDate: "desc" },
      take: 100,
    }),
  ]);

  const upcoming = jobs.filter(
    (job) =>
      OPEN_JOB_STATUSES.includes(job.status) &&
      (!job.scheduledStart || (job.scheduledEnd ?? job.scheduledStart) >= now),
  );
  const past = jobs
    .filter((job) => job.status === "COMPLETED")
    .sort((a, b) => (b.completedAt ?? b.scheduledStart ?? now).getTime() - (a.completedAt ?? a.scheduledStart ?? now).getTime())
    .slice(0, 10);

  const withStatus = estimates.map((estimate) => ({ ...estimate, status: effectiveEstimateStatus(estimate) }));
  const toAnswer = withStatus.filter((estimate) => estimate.status === "SENT" || estimate.status === "VIEWED");
  const answered = withStatus.filter((estimate) => estimate.status === "ACCEPTED").slice(0, 10);

  const billed = invoices.map((invoice) => ({ ...invoice, status: effectiveInvoiceStatus(invoice) }));
  const toPay = billed.filter((invoice) => invoice.balanceCents > 0);
  const paid = billed.filter((invoice) => invoice.balanceCents <= 0).slice(0, 12);

  return { client, org: client.organization, upcoming, past, toAnswer, answered, toPay, paid };
}

export type PortalView = NonNullable<Awaited<ReturnType<typeof portalView>>>;

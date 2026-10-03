import "server-only";

import { prisma } from "../db";
import { effectiveEstimateStatus } from "../documents";
import { formatMoney } from "../money";
import { publicUrl, sendMessage } from "../messaging";
import { portalLine } from "../portal";
import { formatIn, parseDateTimeLocal } from "../time-zone";
import { formatPhone } from "../utils";
import type { WorkflowTemplate } from "./templates";

/**
 * The automations that email a customer.
 *
 * Each finds what has come due, writes one plain email per thing, and records
 * that it did so before sending — the same unique (automation, thing) row the
 * task automations use, so a second sweep the same morning sends nothing.
 *
 * Two rules keep switching one on from turning into a mail-out: only things
 * that came due within the last CATCH_UP_DAYS are written to, and nothing is
 * sent to a customer without an email address (nor recorded, so adding the
 * address later still lets it go while it is in the window).
 */

const CATCH_UP_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;

type Workflow = { id: string; organizationId: string };

type Draft = {
  entity: { type: string; id: string };
  clientId: string;
  to: string | null;
  toName: string;
  subject: string;
  /** The lines between the greeting and the sign-off. */
  lines: string[];
  related: { type: string; id: string };
};

type Business = {
  name: string;
  phone: string | null;
  email: string | null;
  timeZone: string;
  currency: string;
  locale: string;
  reviewUrl: string | null;
};

async function business(organizationId: string): Promise<Business> {
  return prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { name: true, phone: true, email: true, timeZone: true, currency: true, locale: true, reviewUrl: true },
  });
}

/** Records it, then sends it. Null when already sent, or nobody to send to. */
async function send(workflow: Workflow, org: Business, draft: Draft): Promise<string | null> {
  if (!draft.to) return null;

  try {
    await prisma.workflowRun.create({
      data: {
        workflowId: workflow.id,
        organizationId: workflow.organizationId,
        entityType: draft.entity.type,
        entityId: draft.entity.id,
        summary: `Emailed ${draft.toName}: ${draft.subject}`.slice(0, 200),
      },
    });
  } catch {
    return null; // Already sent for this thing.
  }

  const contact = [org.phone ? formatPhone(org.phone) : null, org.email].filter(Boolean).join(" or ");
  await sendMessage({
    organizationId: workflow.organizationId,
    channel: "EMAIL",
    to: draft.to,
    toName: draft.toName,
    subject: draft.subject,
    body: [
      `Hi ${draft.toName},`,
      "",
      ...draft.lines,
      "",
      contact ? `Any questions, just reply or reach us on ${contact}.` : "Any questions, just reply.",
      "",
      ...(await portalLine(draft.clientId)),
      "Thank you,",
      org.name,
    ].join("\n"),
    relatedType: draft.related.type,
    relatedId: draft.related.id,
    createdById: null,
  });

  return `Emailed ${draft.toName}: ${draft.subject}`;
}

/** Runs one email automation; returns what it sent, for the screen to show. */
export async function sweepCustomerEmails(
  workflow: Workflow,
  template: WorkflowTemplate,
  days: number,
  now = new Date(),
): Promise<string[]> {
  const org = await business(workflow.organizationId);
  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const day = (date: Date) => formatIn(date, "EEEE, MMMM d", org.timeZone);
  const drafts: Draft[] = [];

  /** Came due `days` ago, give or take the catch-up window. */
  const dueBetween = { gte: new Date(now.getTime() - (days + CATCH_UP_DAYS) * DAY), lte: new Date(now.getTime() - days * DAY) };

  if (template.trigger === "estimate.unanswered") {
    const estimates = await prisma.estimate.findMany({
      where: {
        organizationId: workflow.organizationId,
        status: { in: ["SENT", "VIEWED"] },
        sentAt: dueBetween,
      },
      select: {
        id: true,
        number: true,
        status: true,
        expiresAt: true,
        totalCents: true,
        publicToken: true,
        clientId: true,
        client: { select: { displayName: true, email: true } },
      },
      take: 200,
    });
    for (const estimate of estimates) {
      if (effectiveEstimateStatus(estimate) === "EXPIRED") continue;
      drafts.push({
        entity: { type: "ESTIMATE", id: estimate.id },
        clientId: estimate.clientId,
        to: estimate.client.email,
        toName: estimate.client.displayName,
        subject: `Following up on estimate ${estimate.number} from ${org.name}`,
        lines: [
          `Just checking in on estimate ${estimate.number} for ${money(estimate.totalCents)}.`,
          estimate.expiresAt ? `It's good until ${day(estimate.expiresAt)}.` : "",
          `You can look it over and accept it here: ${publicUrl(`/share/estimate/${estimate.publicToken}`)}`,
        ].filter(Boolean),
        related: { type: "estimate", id: estimate.id },
      });
    }
  }

  if (template.trigger === "invoice.due-soon" || template.trigger === "invoice.overdue") {
    const soon = template.trigger === "invoice.due-soon";
    const invoices = await prisma.invoice.findMany({
      where: {
        organizationId: workflow.organizationId,
        status: { notIn: ["DRAFT", "CANCELLED", "PAID"] },
        balanceCents: { gt: 0 },
        dueDate: soon ? { gt: now, lte: new Date(now.getTime() + days * DAY) } : dueBetween,
      },
      select: {
        id: true,
        number: true,
        dueDate: true,
        balanceCents: true,
        publicToken: true,
        clientId: true,
        client: { select: { displayName: true, email: true } },
      },
      take: 200,
    });
    for (const invoice of invoices) {
      const link = publicUrl(`/share/invoice/${invoice.publicToken}`);
      drafts.push({
        entity: { type: "INVOICE", id: invoice.id },
        clientId: invoice.clientId,
        to: invoice.client.email,
        toName: invoice.client.displayName,
        subject: soon
          ? `Reminder: invoice ${invoice.number} is due ${day(invoice.dueDate!)}`
          : `Invoice ${invoice.number} is past due`,
        lines: soon
          ? [
              `A friendly reminder that invoice ${invoice.number} for ${money(invoice.balanceCents)} is due on ${day(invoice.dueDate!)}.`,
              `You can view and pay it here: ${link}`,
            ]
          : [
              `Invoice ${invoice.number} for ${money(invoice.balanceCents)} was due on ${day(invoice.dueDate!)} and is still open.`,
              `You can view and pay it here: ${link}`,
              "If you've already paid, thank you — please ignore this.",
            ],
        related: { type: "invoice", id: invoice.id },
      });
    }
  }

  if (template.trigger === "job.upcoming") {
    // Visits on the calendar day `days` from today, on the business's clock.
    const target = formatIn(new Date(now.getTime() + days * DAY), "yyyy-MM-dd", org.timeZone);
    const from = parseDateTimeLocal(`${target}T00:00`, org.timeZone)!;
    const to = new Date(from.getTime() + DAY);
    const jobs = await prisma.job.findMany({
      where: {
        organizationId: workflow.organizationId,
        status: { in: ["SCHEDULED", "CONFIRMED"] },
        scheduledStart: { gte: from, lt: to },
        clientId: { not: null },
      },
      select: {
        id: true,
        title: true,
        allDay: true,
        scheduledStart: true,
        clientId: true,
        client: { select: { displayName: true, email: true } },
        address: { select: { line1: true, city: true } },
      },
      take: 200,
    });
    for (const job of jobs) {
      const when = job.allDay
        ? day(job.scheduledStart!)
        : `${day(job.scheduledStart!)} at ${formatIn(job.scheduledStart!, "h:mm a", org.timeZone)}`;
      const where = job.address ? [job.address.line1, job.address.city].filter(Boolean).join(", ") : null;
      drafts.push({
        // Keyed by the day too: a visit moved to another day is reminded again.
        entity: { type: "JOB", id: `${job.id}@${target}` },
        clientId: job.clientId!,
        to: job.client!.email,
        toName: job.client!.displayName,
        subject: `Reminder: ${org.name} is booked for ${day(job.scheduledStart!)}`,
        lines: [
          `A reminder that we're booked for ${job.title} on ${when}${where ? `, at ${where}` : ""}.`,
          "Need to change it? Just let us know.",
        ],
        related: { type: "job", id: job.id },
      });
    }
  }

  if (template.trigger === "job.completed" && org.reviewUrl) {
    const jobs = await prisma.job.findMany({
      where: {
        organizationId: workflow.organizationId,
        status: "COMPLETED",
        completedAt: dueBetween,
        clientId: { not: null },
      },
      select: {
        id: true,
        clientId: true,
        client: { select: { displayName: true, email: true } },
      },
      orderBy: { completedAt: "desc" },
      take: 200,
    });
    for (const job of jobs) {
      drafts.push({
        // Once per customer, ever: a weekly lawn does not mean a weekly ask.
        entity: { type: "CLIENT", id: job.clientId! },
        clientId: job.clientId!,
        to: job.client!.email,
        toName: job.client!.displayName,
        subject: `Thank you from ${org.name}`,
        lines: [
          `Thank you for choosing ${org.name}.`,
          `If you have a minute, a review would mean a lot to a small business like ours: ${org.reviewUrl}`,
        ],
        related: { type: "job", id: job.id },
      });
    }
  }

  const sent: string[] = [];
  for (const draft of drafts) {
    const summary = await send(workflow, org, draft);
    if (summary) sent.push(summary);
  }
  return sent;
}

import "server-only";

import { endOfDay } from "date-fns";

import { record } from "./activity";
import { entitlement } from "./billing/entitlement";
import { isRole, type RecurrenceFrequency } from "./constants";
import { prisma } from "./db";
import { notify } from "./notifications";
import { allocateNumber } from "./numbering";
import { can } from "./permissions";
import { nextInSeries } from "./recurrence";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Repeating invoices.
 *
 * A schedule says how often; the invoices in its series say what. Each period
 * the next invoice is made as a DRAFT, copied from the latest invoice in the
 * series, and whoever set the repeat up is told it is waiting. Nothing is
 * emailed from here. The business chose drafts to review over invoices that
 * send themselves, so a wrong amount is caught by a person before a customer
 * ever sees it.
 *
 * Copying the latest invoice rather than the first is what lets a price change
 * carry forward: edit next month's draft and every month after it follows. A
 * one-off line added to one month carries forward too — which the review is
 * there to catch, and which is one deletion rather than a price retyped every
 * month.
 *
 * Like the automations, this is swept for rather than woken: the morning run
 * and the desktop's own timer call `draftDueInvoices()`, and saving a repeat
 * whose first date is today calls it for that one schedule.
 */

/**
 * How many missed periods one run catches up for a single schedule.
 *
 * A desktop copy that was off for a month owes the weekly customer four
 * invoices, and each is real work that was done. A copy off for two years
 * does not need a hundred drafts in one go; the next run carries on.
 */
export const MAX_DRAFTS_PER_RUN = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

export type DraftedInvoice = {
  id: string;
  number: string;
  organizationId: string;
};

type Schedule = {
  id: string;
  organizationId: string;
  frequency: string;
  interval: number;
  anchorDate: Date;
  nextIssueDate: Date;
  endDate: Date | null;
  createdById: string | null;
};

/**
 * The invoice the next draft copies: the latest in the series that was not
 * cancelled, since a cancelled invoice is usually one that was wrong.
 *
 * If every invoice left in the series is cancelled, the latest of those
 * still serves. A customer who skipped a month should not quietly stop being
 * billed because the one invoice left happened to be the skipped one; a
 * schedule stops when somebody stops it, or when nothing is left to copy.
 */
async function sourceFor(tx: Prisma.TransactionClient, schedule: Schedule) {
  const include = {
    lineItems: { orderBy: { sortOrder: "asc" as const } },
    client: { select: { displayName: true } },
  };
  const orderBy = [{ issueDate: "desc" as const }, { createdAt: "desc" as const }];
  const where = { scheduleId: schedule.id, organizationId: schedule.organizationId };

  return (
    (await tx.invoice.findFirst({
      where: { ...where, status: { not: "CANCELLED" } },
      orderBy,
      include,
    })) ?? (await tx.invoice.findFirst({ where, orderBy, include }))
  );
}

/**
 * Makes the one draft this schedule is due, if it is due.
 *
 * The date is claimed before anything is written: the schedule moves on only
 * if it still holds the date that was read, in the same transaction as the
 * invoice. Two runs at once — the morning run and a desktop timer, or a
 * double-clicked save — both try, and exactly one of them makes the draft.
 */
async function draftNext(
  schedule: Schedule,
  now: Date,
  actorId?: string,
): Promise<DraftedInvoice | null> {
  const issueDate = schedule.nextIssueDate;
  if (issueDate > endOfDay(now)) return null;

  const pastEnd = (date: Date) =>
    schedule.endDate !== null && date > endOfDay(schedule.endDate);

  if (pastEnd(issueDate)) {
    await prisma.invoiceSchedule.updateMany({
      where: { id: schedule.id, nextIssueDate: issueDate },
      data: { isActive: false },
    });
    return null;
  }

  const following = nextInSeries(
    issueDate,
    schedule.frequency as RecurrenceFrequency,
    schedule.interval,
    schedule.anchorDate,
  );

  const made = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const claimed = await tx.invoiceSchedule.updateMany({
      where: { id: schedule.id, isActive: true, nextIssueDate: issueDate },
      data: { nextIssueDate: following, isActive: !pastEnd(following), lastRunAt: now },
    });
    if (claimed.count === 0) return null;

    const source = await sourceFor(tx, schedule);
    if (!source) {
      // Every invoice in the series was deleted, so there is nothing to copy.
      // Put the date back and stop, rather than advancing forever over nothing.
      await tx.invoiceSchedule.update({
        where: { id: schedule.id },
        data: { nextIssueDate: issueDate, isActive: false },
      });
      return null;
    }

    const number = await allocateNumber(tx, schedule.organizationId, "invoice");

    const created = await tx.invoice.create({
      data: {
        organizationId: schedule.organizationId,
        number,
        title: source.title,
        status: "DRAFT",
        clientId: source.clientId,
        addressId: source.addressId,
        // Not the job: last month's visit is not this month's.
        scheduleId: schedule.id,
        issueDate,
        paymentTermsDays: source.paymentTermsDays,
        dueDate: new Date(issueDate.getTime() + source.paymentTermsDays * DAY_MS),
        subtotalCents: source.subtotalCents,
        discountType: source.discountType,
        discountValue: source.discountValue,
        discountCents: source.discountCents,
        taxRateBp: source.taxRateBp,
        taxCents: source.taxCents,
        totalCents: source.totalCents,
        amountPaidCents: 0,
        balanceCents: source.totalCents,
        notes: source.notes,
        terms: source.terms,
        // Whoever set the repeat up raised this, in effect — and it is who
        // hears when it is paid.
        createdById: schedule.createdById,
        lineItems: {
          create: source.lineItems.map((item) => ({
            kind: item.kind,
            name: item.name,
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unitPriceCents: item.unitPriceCents,
            taxable: item.taxable,
            totalCents: item.totalCents,
            sortOrder: item.sortOrder,
          })),
        },
      },
      select: { id: true, number: true },
    });

    return { ...created, clientName: source.client.displayName };
  });

  if (!made) return null;

  await tellReviewers(schedule, made, actorId);

  await record({
    organizationId: schedule.organizationId,
    userId: null,
    action: "invoice.drafted",
    entityType: "INVOICE",
    entityId: made.id,
    summary: `Invoice ${made.number} drafted for ${made.clientName} from a repeating invoice`,
  });

  return { id: made.id, number: made.number, organizationId: schedule.organizationId };
}

/**
 * Tells somebody the draft is waiting.
 *
 * Whoever set the repeat up, or everyone who can send invoices once that
 * person has gone, so a draft never waits unseen. Not whoever is making it
 * happen right now by saving the repeat — they are looking at the answer
 * already.
 */
async function tellReviewers(
  schedule: Schedule,
  draft: { id: string; number: string; clientName: string },
  actorId?: string,
) {
  // Auto-pay collects it: there is nothing for anybody to send, and the
  // payment landing is what they hear about instead.
  const collecting = await prisma.autopaySubscription.count({
    where: { scheduleId: schedule.id, status: { in: ["ACTIVE", "APPROVED"] } },
  });
  if (collecting > 0) return;

  await notify({
    organizationId: schedule.organizationId,
    userIds: await whoHandlesBilling(schedule.organizationId, schedule.createdById),
    type: "INVOICE_DRAFTED",
    title: `Invoice ${draft.number} for ${draft.clientName} is ready to check`,
    body: "Made by a repeating invoice. Nothing has been sent — look it over, then send it.",
    entityType: "invoice",
    entityId: draft.id,
    actionUrl: `/invoices/${draft.id}`,
    exceptUserId: actorId,
  });
}

/**
 * The people to tell about a repeating invoice.
 *
 * Whoever set it up, while they are still here and can still send invoices;
 * otherwise everyone who can, so nothing waits unseen because the person
 * who scheduled it left.
 */
export async function whoHandlesBilling(
  organizationId: string,
  preferredUserId: string | null,
): Promise<string[]> {
  const people = await prisma.user.findMany({
    where: { organizationId, isActive: true },
    select: { id: true, role: true },
  });

  const senders = people.filter(
    (person) => isRole(person.role) && can({ role: person.role, id: person.id }, "invoices:send"),
  );
  const preferred = senders.find((person) => person.id === preferredUserId);

  return (preferred ? [preferred] : senders).map((person) => person.id);
}

/**
 * Makes every draft that has come due.
 *
 * What the morning run calls with no arguments, and what saving a repeat
 * calls for its own schedule. Each schedule is its own attempt: one that
 * fails is named and logged, and the rest still get their drafts.
 *
 * Not for the demo, which must look the same to every visitor, nor for a
 * business that is locked for want of payment — it cannot open the drafts,
 * and they will be made when it reopens, since the dates wait for it.
 */
export async function draftDueInvoices(
  options: {
    now?: Date;
    organizationId?: string;
    scheduleId?: string;
    /** Somebody who caused this run and so needs no notification of it. */
    actorId?: string;
  } = {},
): Promise<{ drafted: DraftedInvoice[]; failed: string[] }> {
  const now = options.now ?? new Date();

  const due = await prisma.invoiceSchedule.findMany({
    where: {
      isActive: true,
      nextIssueDate: { lte: endOfDay(now) },
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      ...(options.scheduleId ? { id: options.scheduleId } : {}),
      organization: { isDemo: false },
    },
    select: { id: true, organizationId: true },
    orderBy: { nextIssueDate: "asc" },
    take: 500,
  });

  const open = new Set(
    (
      await prisma.organization.findMany({
        where: { id: { in: [...new Set(due.map((row) => row.organizationId))] } },
      })
    )
      .filter((org) => entitlement(org, now).ok)
      .map((org) => org.id),
  );

  const drafted: DraftedInvoice[] = [];
  const failed: string[] = [];

  for (const { id } of due.filter((row) => open.has(row.organizationId))) {
    try {
      for (let made = 0; made < MAX_DRAFTS_PER_RUN; made++) {
        // Read fresh each time round: the last draft moved the date on.
        const schedule = await prisma.invoiceSchedule.findFirst({
          where: { id, isActive: true },
        });
        if (!schedule) break;

        const draft = await draftNext(schedule, now, options.actorId);
        if (!draft) break;
        drafted.push(draft);
      }
    } catch (error) {
      failed.push(id);
      console.error(`[repeating invoices] could not draft for schedule ${id}`, error);
    }
  }

  return { drafted, failed };
}

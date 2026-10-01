import "server-only";

import { endOfDay, format } from "date-fns";

import { entitlement } from "./billing/entitlement";
import { isRole, type RecurrenceFrequency } from "./constants";
import { prisma } from "./db";
import { formatMoney } from "./money";
import { notify } from "./notifications";
import { can } from "./permissions";
import { nextInSeries } from "./recurrence";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Repeating expenses: rent, software, insurance, the electric bill.
 *
 * A schedule says how often; the expenses in its series say what. Each period
 * copies the latest expense in the series, so a new price carries forward —
 * edit this month's and next month's follows. What happens on the date is the
 * business's choice, made per repeat:
 *
 *   - Same amount every time: the expense is recorded by itself. Nobody is
 *     interrupted; it is in the books, and in the reports, on its date.
 *   - Amount changes: a task to enter the real bill, assigned to whoever set
 *     the repeat up, and a notification that opens the expense form already
 *     filled in from last time. Nothing is recorded until somebody does, so a
 *     guessed amount never reaches the books.
 *
 * Swept for like repeating invoices: the morning run and the desktop's own
 * timer call `recordDueExpenses()`, and saving a repeat whose date is today
 * calls it for that one schedule.
 */

/** How many missed periods one run catches up for a single schedule. */
export const MAX_PER_RUN = 12;

type Schedule = {
  id: string;
  organizationId: string;
  frequency: string;
  interval: number;
  anchorDate: Date;
  nextDate: Date;
  endDate: Date | null;
  amountVaries: boolean;
  createdById: string | null;
};

type Money = { currency: string; locale: string };

export type DueExpense =
  | { kind: "recorded"; expenseId: string; organizationId: string }
  | { kind: "reminder"; taskId: string; organizationId: string };

/** The expense the next one copies: the latest in the series. */
function latestInSeries(tx: Prisma.TransactionClient, schedule: Schedule) {
  return tx.expense.findFirst({
    where: { scheduleId: schedule.id, organizationId: schedule.organizationId },
    orderBy: [{ spentAt: "desc" }, { createdAt: "desc" }],
  });
}

/** The latest expense in a series, for screens that show or prefill from it. */
export function latestExpenseIn(scheduleId: string, organizationId: string) {
  return prisma.expense.findFirst({
    where: { scheduleId, organizationId },
    orderBy: [{ spentAt: "desc" }, { createdAt: "desc" }],
  });
}

/**
 * Records, or raises the task for, the one period this schedule has due.
 *
 * The date is claimed before anything is written: the schedule moves on only
 * if it still holds the date that was read, in the same transaction as the
 * expense or task. Two runs at once — the morning run and a desktop timer, or
 * a double-clicked save — both try, and exactly one of them does it.
 */
async function runNext(
  schedule: Schedule,
  money: Money,
  now: Date,
  actorId?: string,
): Promise<DueExpense | null> {
  const date = schedule.nextDate;
  if (date > endOfDay(now)) return null;

  const pastEnd = (when: Date) =>
    schedule.endDate !== null && when > endOfDay(schedule.endDate);

  if (pastEnd(date)) {
    await prisma.expenseSchedule.updateMany({
      where: { id: schedule.id, nextDate: date },
      data: { isActive: false },
    });
    return null;
  }

  const following = nextInSeries(
    date,
    schedule.frequency as RecurrenceFrequency,
    schedule.interval,
    schedule.anchorDate,
  );

  // Whoever set the repeat up is who it is for, while they are still here.
  const handlers = await whoHandlesExpenses(schedule.organizationId, schedule.createdById);
  const owner = schedule.createdById && handlers.includes(schedule.createdById)
    ? schedule.createdById
    : null;

  const made = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const claimed = await tx.expenseSchedule.updateMany({
      where: { id: schedule.id, isActive: true, nextDate: date },
      data: { nextDate: following, isActive: !pastEnd(following), lastRunAt: now },
    });
    if (claimed.count === 0) return null;

    const source = await latestInSeries(tx, schedule);
    if (!source) {
      // Every expense in the series was deleted, so there is nothing to copy.
      // Put the date back and stop, rather than advancing forever over nothing.
      await tx.expenseSchedule.update({
        where: { id: schedule.id },
        data: { nextDate: date, isActive: false },
      });
      return null;
    }

    if (schedule.amountVaries) {
      const dueAt = new Date(date);
      dueAt.setHours(23, 59, 59, 0);

      const task = await tx.task.create({
        data: {
          organizationId: schedule.organizationId,
          title: `Enter ${source.description} for ${format(date, "MMM d")}`,
          notes: `Last time: ${formatMoney(source.amountCents, money.currency, money.locale)}${
            source.vendor ? ` to ${source.vendor}` : ""
          }.`,
          status: "OPEN",
          dueAt,
          assignedToId: owner,
          expenseScheduleId: schedule.id,
        },
        select: { id: true },
      });

      return { kind: "reminder" as const, taskId: task.id, source };
    }

    // A payer who has since left cannot be owed this one.
    const payer = source.paidById
      ? await tx.user.findFirst({
          where: { id: source.paidById, organizationId: schedule.organizationId, isActive: true },
          select: { id: true },
        })
      : null;

    const expense = await tx.expense.create({
      data: {
        organizationId: schedule.organizationId,
        scheduleId: schedule.id,
        description: source.description,
        category: source.category,
        vendor: source.vendor,
        amountCents: source.amountCents,
        taxCents: source.taxCents,
        method: source.method,
        // A receipt number belongs to one receipt.
        reference: null,
        spentAt: date,
        jobId: source.jobId,
        clientId: source.clientId,
        billable: source.billable,
        reimbursable: source.reimbursable && payer !== null,
        paidById: payer?.id ?? null,
        createdById: schedule.createdById,
      },
      select: { id: true },
    });

    return { kind: "recorded" as const, expenseId: expense.id, source };
  });

  if (!made) return null;

  if (made.kind === "reminder") {
    const day = format(date, "yyyy-MM-dd");
    await notify({
      organizationId: schedule.organizationId,
      userIds: owner ? [owner] : handlers,
      type: "EXPENSE_DUE",
      title: `Time to enter ${made.source.description}`,
      body: `Due ${format(date, "MMM d")}. Last time it was ${formatMoney(
        made.source.amountCents,
        money.currency,
        money.locale,
      )}.`,
      entityType: "expense",
      entityId: made.source.id,
      actionUrl: `/expenses/new?repeat=${schedule.id}&date=${day}`,
      exceptUserId: actorId,
    });
    return { kind: "reminder", taskId: made.taskId, organizationId: schedule.organizationId };
  }

  return { kind: "recorded", expenseId: made.expenseId, organizationId: schedule.organizationId };
}

/**
 * The people a repeating expense is for: whoever set it up, while they are
 * still here and can still record expenses; otherwise everyone who can, so a
 * bill never waits unseen because the person who scheduled it left.
 */
export async function whoHandlesExpenses(
  organizationId: string,
  preferredUserId: string | null,
): Promise<string[]> {
  const people = await prisma.user.findMany({
    where: { organizationId, isActive: true },
    select: { id: true, role: true },
  });

  const writers = people.filter(
    (person) => isRole(person.role) && can({ role: person.role, id: person.id }, "expenses:write"),
  );
  const preferred = writers.find((person) => person.id === preferredUserId);

  return (preferred ? [preferred] : writers).map((person) => person.id);
}

/**
 * Does everything that has come due.
 *
 * What the morning run calls with no arguments, and what saving a repeat
 * calls for its own schedule. Each schedule is its own attempt: one that
 * fails is named and logged, and the rest still run.
 *
 * Not for the demo, which must look the same to every visitor, nor for a
 * business locked for want of payment — the dates wait for it to reopen.
 */
export async function recordDueExpenses(
  options: {
    now?: Date;
    organizationId?: string;
    scheduleId?: string;
    /** Somebody who caused this run and so needs no notification of it. */
    actorId?: string;
  } = {},
): Promise<{ done: DueExpense[]; failed: string[] }> {
  const now = options.now ?? new Date();

  const due = await prisma.expenseSchedule.findMany({
    where: {
      isActive: true,
      nextDate: { lte: endOfDay(now) },
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      ...(options.scheduleId ? { id: options.scheduleId } : {}),
      organization: { isDemo: false },
    },
    select: { id: true, organizationId: true },
    orderBy: { nextDate: "asc" },
    take: 500,
  });

  const open = new Map<string, Money>();
  for (const org of await prisma.organization.findMany({
    where: { id: { in: [...new Set(due.map((row) => row.organizationId))] } },
  })) {
    if (entitlement(org, now).ok) open.set(org.id, { currency: org.currency, locale: org.locale });
  }

  const done: DueExpense[] = [];
  const failed: string[] = [];

  for (const { id, organizationId } of due) {
    const money = open.get(organizationId);
    if (!money) continue;

    try {
      for (let count = 0; count < MAX_PER_RUN; count++) {
        // Read fresh each time round: the last one moved the date on.
        const schedule = await prisma.expenseSchedule.findFirst({
          where: { id, isActive: true },
        });
        if (!schedule) break;

        const result = await runNext(schedule, money, now, options.actorId);
        if (!result) break;
        done.push(result);
      }
    } catch (error) {
      failed.push(id);
      console.error(`[repeating expenses] could not run schedule ${id}`, error);
    }
  }

  return { done, failed };
}

/**
 * Roughly what one period of a fixed bill costs per month, for the total on
 * the expenses screen. Weekly is 52 weeks over 12 months.
 */
export function monthlyEquivalentCents(
  amountCents: number,
  frequency: string,
  interval: number,
): number {
  const every = Math.max(1, interval);
  if (frequency === "WEEKLY") return Math.round((amountCents * 52) / 12 / every);
  if (frequency === "YEARLY") return Math.round(amountCents / 12 / every);
  return Math.round(amountCents / every);
}

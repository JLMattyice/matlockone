import "server-only";

import { endOfDay, format } from "date-fns";

import type { CalendarBill } from "./types";
import type { AppContext } from "@/lib/auth";
import { seesBillsOnCalendar } from "@/lib/bills-calendar";
import type { RecurrenceFrequency } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";
import { nextInSeries } from "@/lib/recurrence";

/** Steps one series may take across a range: a weekly bill in a month view is five. */
const MAX_STEPS = 400;

/** A bill date as a day, the way the expense screens key them. */
const dayOf = (date: Date) => format(date, "yyyy-MM-dd");

/**
 * The repeating bills that fall between `from` and `to`, for the calendar.
 *
 * Three sources, one per state. Bills still to come are worked out from each
 * repeat's next date and rhythm, at the latest amount in its series — the one
 * the next period copies. A bill whose amount changes every time and whose
 * date has passed is waiting for somebody to enter it: its open reminder is
 * the entry. A bill already recorded is shown as paid, at what was recorded.
 *
 * Nothing for somebody whose role the owner has not given the calendar.
 */
export async function billsOnCalendar(ctx: AppContext, from: Date, to: Date): Promise<CalendarBill[]> {
  const { user, org } = ctx;
  if (!seesBillsOnCalendar(user.role, org.billsOnCalendarRoles)) return [];

  const seesAmounts = can(user, "expenses:read");
  const canEnter = can(user, "expenses:write");
  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);

  const [schedules, recorded, reminders] = await Promise.all([
    prisma.expenseSchedule.findMany({
      where: { organizationId: org.id, isActive: true, nextDate: { lte: to } },
      select: {
        id: true,
        frequency: true,
        interval: true,
        anchorDate: true,
        nextDate: true,
        endDate: true,
        amountVaries: true,
        expenses: {
          orderBy: [{ spentAt: "desc" }, { createdAt: "desc" }],
          take: 1,
          select: { id: true, description: true, amountCents: true },
        },
      },
    }),
    prisma.expense.findMany({
      where: { organizationId: org.id, scheduleId: { not: null }, spentAt: { gte: from, lte: to } },
      select: { id: true, scheduleId: true, description: true, amountCents: true, spentAt: true },
    }),
    prisma.task.findMany({
      where: {
        organizationId: org.id,
        status: "OPEN",
        expenseScheduleId: { not: null },
        dueAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        dueAt: true,
        expenseSchedule: {
          select: {
            id: true,
            expenses: {
              orderBy: [{ spentAt: "desc" }, { createdAt: "desc" }],
              take: 1,
              select: { id: true, description: true, amountCents: true },
            },
          },
        },
      },
    }),
  ]);

  const bills: CalendarBill[] = [];
  const paidDays = new Set<string>();

  for (const expense of recorded) {
    paidDays.add(`${expense.scheduleId}@${dayOf(expense.spentAt)}`);
    bills.push({
      key: `paid:${expense.id}`,
      title: expense.description,
      amount: seesAmounts ? money(expense.amountCents) : null,
      dateISO: expense.spentAt.toISOString(),
      state: "paid",
      href: seesAmounts ? `/expenses/${expense.id}` : null,
    });
  }

  for (const reminder of reminders) {
    const schedule = reminder.expenseSchedule;
    const latest = schedule?.expenses[0];
    if (!schedule || !latest || !reminder.dueAt) continue;
    // The bill's own date: the reminder is due at the end of it.
    const date = new Date(reminder.dueAt);
    date.setHours(12, 0, 0, 0);
    if (paidDays.has(`${schedule.id}@${dayOf(date)}`)) continue;
    bills.push({
      key: `waiting:${reminder.id}`,
      title: latest.description,
      amount: seesAmounts ? `about ${money(latest.amountCents)}` : null,
      dateISO: date.toISOString(),
      state: "waiting",
      href: canEnter
        ? `/expenses/new?repeat=${schedule.id}&date=${dayOf(date)}`
        : seesAmounts
          ? `/expenses/${latest.id}`
          : null,
    });
  }

  for (const schedule of schedules) {
    const latest = schedule.expenses[0];
    // A series with nothing left in it stops itself on its next date.
    if (!latest) continue;

    let cursor = schedule.nextDate;
    for (let step = 0; cursor <= to && step < MAX_STEPS; step++) {
      if (schedule.endDate && cursor > endOfDay(schedule.endDate)) break;
      if (cursor >= from && !paidDays.has(`${schedule.id}@${dayOf(cursor)}`)) {
        bills.push({
          key: `due:${schedule.id}@${dayOf(cursor)}`,
          title: latest.description,
          amount: seesAmounts
            ? `${schedule.amountVaries ? "about " : ""}${money(latest.amountCents)}`
            : null,
          dateISO: cursor.toISOString(),
          state: "upcoming",
          href: seesAmounts ? `/expenses/${latest.id}` : null,
        });
      }
      cursor = nextInSeries(cursor, schedule.frequency as RecurrenceFrequency, schedule.interval, schedule.anchorDate);
    }
  }

  return bills.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.title.localeCompare(b.title));
}

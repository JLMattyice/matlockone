"use server";

import { revalidatePath } from "next/cache";
import { endOfDay, format, startOfDay, subDays } from "date-fns";
import { z } from "zod";

import { bool, failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { INVOICE_REPEAT_FREQUENCIES } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { describeRecurrence } from "@/lib/recurrence";
import { recordDueExpenses } from "@/lib/recurring-expenses";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Setting an expense to repeat, changing how, and stopping it.
 *
 * What happens each period is src/lib/recurring-expenses.ts. Saving a repeat
 * whose next date is today does today's straight away, rather than leaving
 * somebody to wonder until tomorrow morning whether it worked.
 */

const repeatSchema = z.object({
  expenseId: z.string().min(1),
  frequency: z.enum(INVOICE_REPEAT_FREQUENCIES),
  interval: z.coerce
    .number({ error: "Enter how many." })
    .int("Enter a whole number.")
    .min(1, "At least 1.")
    .max(24, "At most 24."),
  nextDate: z.string().trim().min(1, "Pick the date of the next one."),
  endDate: z.string().trim().nullish(),
  amountVaries: z.boolean(),
});

/** Noon, like every other date typed into a form here, so no timezone moves it a day. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function saveExpenseRepeat(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("expenses:write");

  const parsed = repeatSchema.safeParse({
    expenseId: formData.get("expenseId"),
    frequency: formData.get("frequency"),
    interval: formData.get("interval"),
    nextDate: formData.get("nextDate"),
    endDate: text(formData, "endDate"),
    amountVaries: formData.get("amountVaries") === "VARIES" || bool(formData, "amountVaries"),
  });
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;

  const next = parseDate(input.nextDate);
  if (!next) return { ok: false, fieldErrors: { nextDate: "Pick a valid date." } };

  // A day of slack: the server keeps UTC, so "today" for somebody in the
  // evening in America is already tomorrow there. A date further back would
  // catch up every period since, which is never what was meant.
  if (next < startOfDay(subDays(new Date(), 1))) {
    return { ok: false, fieldErrors: { nextDate: "Pick today or a later date." } };
  }

  const end = input.endDate ? parseDate(input.endDate) : null;
  if (input.endDate && !end) {
    return { ok: false, fieldErrors: { endDate: "Pick a valid date, or leave it empty." } };
  }
  if (end && end < next) {
    return {
      ok: false,
      fieldErrors: { endDate: "That is before the next one. Pick a later date, or leave it empty." },
    };
  }

  const expense = await prisma.expense.findFirst({
    where: { id: input.expenseId, organizationId: org.id },
    select: { id: true, scheduleId: true, description: true },
  });
  if (!expense) return failed("That expense no longer exists.");

  const settings = {
    frequency: input.frequency,
    interval: input.interval,
    // New settings start a new rhythm, anchored on the date just chosen.
    anchorDate: next,
    nextDate: next,
    endDate: end,
    isActive: true,
    amountVaries: input.amountVaries,
    // Whoever saves it last is who it is for.
    createdById: user.id,
  };

  const scheduleId = await prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<string> => {
      if (expense.scheduleId) {
        await tx.expenseSchedule.updateMany({
          where: { id: expense.scheduleId, organizationId: org.id },
          data: settings,
        });
        return expense.scheduleId;
      }

      const created = await tx.expenseSchedule.create({
        data: { ...settings, organizationId: org.id },
        select: { id: true },
      });
      await tx.expense.update({
        where: { id: expense.id },
        data: { scheduleId: created.id },
      });
      return created.id;
    },
  );

  const rhythm = describeRecurrence({
    frequency: input.frequency,
    interval: input.interval,
  }).toLowerCase();

  const ran =
    next <= endOfDay(new Date())
      ? await recordDueExpenses({ organizationId: org.id, scheduleId, actorId: user.id })
      : { done: [], failed: [] };

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${expense.id}`);
  revalidatePath("/tasks");

  if (ran.failed.length > 0) {
    return saved(
      `Repeating ${rhythm}, but today's could not be done. It will be tried again on the next morning run.`,
    );
  }

  const today = ran.done[0];
  if (today?.kind === "recorded") {
    return saved(`Repeating ${rhythm}. Today's has been recorded.`);
  }
  if (today?.kind === "reminder") {
    return saved(`Repeating ${rhythm}. Today's is on your task list to enter.`);
  }

  const when = format(next, "MMM d, yyyy");
  return saved(
    input.amountVaries
      ? `Repeating ${rhythm}. You will be reminded to enter the next one on ${when}.`
      : `Repeating ${rhythm}. The next one is recorded on ${when}.`,
  );
}

export async function stopExpenseRepeat(formData: FormData) {
  const { org } = await requirePermission("expenses:write");

  const id = String(formData.get("expenseId") ?? "");
  if (!id) return;

  const expense = await prisma.expense.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true, scheduleId: true },
  });
  if (!expense?.scheduleId) return;

  // The expenses already recorded stay exactly as they are; only the next one
  // is not. A reminder still open is for a bill that really came, so it stays.
  await prisma.expenseSchedule.updateMany({
    where: { id: expense.scheduleId, organizationId: org.id, isActive: true },
    data: { isActive: false },
  });

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${expense.id}`);
}

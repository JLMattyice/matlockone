"use server";

import { revalidatePath } from "next/cache";
import { endOfDay, format, startOfDay, subDays } from "date-fns";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { record } from "@/lib/activity";
import { requirePermission } from "@/lib/auth";
import { INVOICE_REPEAT_FREQUENCIES } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { describeRecurrence } from "@/lib/recurrence";
import { draftDueInvoices } from "@/lib/recurring-invoices";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Setting an invoice to repeat, changing how, and stopping it.
 *
 * The drafts themselves are made by src/lib/recurring-invoices.ts. Saving a
 * repeat whose next date is today makes that draft straight away, rather
 * than leaving somebody to wonder until tomorrow morning whether it worked.
 */

const repeatSchema = z.object({
  invoiceId: z.string().min(1),
  frequency: z.enum(INVOICE_REPEAT_FREQUENCIES),
  interval: z.coerce
    .number({ error: "Enter how many." })
    .int("Enter a whole number.")
    .min(1, "At least 1.")
    .max(24, "At most 24."),
  nextIssueDate: z.string().trim().min(1, "Pick the date of the next invoice."),
  endDate: z.string().trim().nullish(),
});

/** Noon, like every other date typed into a form here, so no timezone moves it a day. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function saveInvoiceRepeat(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("invoices:write");

  const parsed = repeatSchema.safeParse({
    invoiceId: formData.get("invoiceId"),
    frequency: formData.get("frequency"),
    interval: formData.get("interval"),
    nextIssueDate: formData.get("nextIssueDate"),
    endDate: text(formData, "endDate"),
  });
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;

  const next = parseDate(input.nextIssueDate);
  if (!next) {
    return { ok: false, fieldErrors: { nextIssueDate: "Pick a valid date." } };
  }
  // A day of slack: the server keeps UTC, so "today" for somebody in the
  // evening in America is already tomorrow there. A date further back would
  // make a draft for every period since, which is never what was meant.
  if (next < startOfDay(subDays(new Date(), 1))) {
    return { ok: false, fieldErrors: { nextIssueDate: "Pick today or a later date." } };
  }

  const end = input.endDate ? parseDate(input.endDate) : null;
  if (input.endDate && !end) {
    return { ok: false, fieldErrors: { endDate: "Pick a valid date, or leave it empty." } };
  }
  if (end && end < next) {
    return {
      ok: false,
      fieldErrors: { endDate: "That is before the next invoice. Pick a later date, or leave it empty." },
    };
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: org.id },
    select: { id: true, number: true, status: true, scheduleId: true },
  });
  if (!invoice) return failed("That invoice no longer exists.");
  if (invoice.status === "CANCELLED") {
    return failed("This invoice has been cancelled. Repeat one that is not.");
  }

  const settings = {
    frequency: input.frequency,
    interval: input.interval,
    // New settings start a new rhythm, anchored on the date just chosen.
    anchorDate: next,
    nextIssueDate: next,
    endDate: end,
    isActive: true,
    // Whoever saves it last is who hears about each draft.
    createdById: user.id,
  };

  const scheduleId = await prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<string> => {
      if (invoice.scheduleId) {
        await tx.invoiceSchedule.updateMany({
          where: { id: invoice.scheduleId, organizationId: org.id },
          data: settings,
        });
        return invoice.scheduleId;
      }

      const created = await tx.invoiceSchedule.create({
        data: { ...settings, organizationId: org.id },
        select: { id: true },
      });
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { scheduleId: created.id },
      });
      return created.id;
    },
  );

  const rhythm = describeRecurrence({
    frequency: input.frequency,
    interval: input.interval,
  }).toLowerCase();

  await record({
    organizationId: org.id,
    userId: user.id,
    action: "invoice.repeat",
    entityType: "INVOICE",
    entityId: invoice.id,
    summary: `Invoice ${invoice.number} set to repeat ${rhythm}, next on ${format(next, "MMM d, yyyy")}`,
  });

  const made =
    next <= endOfDay(new Date())
      ? await draftDueInvoices({ organizationId: org.id, scheduleId, actorId: user.id })
      : { drafted: [], failed: [] };

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoice.id}`);
  for (const draft of made.drafted) revalidatePath(`/invoices/${draft.id}`);

  if (made.failed.length > 0) {
    return saved(
      `Repeating ${rhythm}, but today's draft could not be made. It will be tried again on the next morning run.`,
    );
  }

  const first = made.drafted[0];
  return saved(
    first
      ? `Repeating ${rhythm}. Today's draft, ${first.number}, is ready to check.`
      : `Repeating ${rhythm}. The next draft is made on ${format(next, "MMM d, yyyy")}.`,
  );
}

export async function stopInvoiceRepeat(formData: FormData) {
  const { user, org } = await requirePermission("invoices:write");

  const id = String(formData.get("invoiceId") ?? "");
  if (!id) return;

  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true, number: true, scheduleId: true },
  });
  if (!invoice?.scheduleId) return;

  // The invoices already made stay exactly as they are; only the next one
  // is not made.
  const { count } = await prisma.invoiceSchedule.updateMany({
    where: { id: invoice.scheduleId, organizationId: org.id, isActive: true },
    data: { isActive: false },
  });

  if (count > 0) {
    await record({
      organizationId: org.id,
      userId: user.id,
      action: "invoice.repeat",
      entityType: "INVOICE",
      entityId: invoice.id,
      summary: `Stopped repeating invoice ${invoice.number}`,
    });
  }

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoice.id}`);
}

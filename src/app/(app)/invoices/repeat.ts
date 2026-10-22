"use server";

import { revalidatePath } from "next/cache";
import { endOfDay, format, startOfDay, subDays } from "date-fns";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { record } from "@/lib/activity";
import { requirePermission } from "@/lib/auth";
import { COLLECTING_STATUSES, turnOffAutopay } from "@/lib/autopay";
import { INVOICE_REPEAT_FREQUENCIES } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { describeRecurrence } from "@/lib/recurrence";
import { resolveEmailAccount } from "@/lib/messaging";
import { draftDueInvoices } from "@/lib/recurring-invoices";
import { sendScheduledInvoices } from "@/lib/scheduled-invoices";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Setting an invoice to repeat, changing how, and stopping it.
 *
 * The drafts themselves are made by src/lib/recurring-invoices.ts. Saving a
 * repeat whose next date is today makes that draft straight away — and sends
 * it, for a repeat that sends itself — rather than leaving somebody to wonder
 * until tomorrow morning whether it worked.
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
  /** Email each one to the client on its day, rather than draft it for checking. */
  autoSend: z.boolean(),
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
    autoSend: formData.get("autoSend") === "SEND",
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
    select: {
      id: true,
      number: true,
      status: true,
      scheduleId: true,
      client: { select: { email: true } },
    },
  });
  if (!invoice) return failed("That invoice no longer exists.");
  if (invoice.status === "CANCELLED") {
    return failed("This invoice has been cancelled. Repeat one that is not.");
  }

  // Refused now rather than found out on the day, when nobody is watching.
  if (input.autoSend) {
    if (!invoice.client.email) {
      return failed(
        "This client has no email address. Add one to the client, or make drafts to send yourself.",
      );
    }
    if (!(await resolveEmailAccount(org.id))) {
      return failed(
        "Connect an email account under Settings → Email first, or make drafts to send yourself.",
      );
    }
  }

  // PayPal is charging on the rhythm it was given. Moving this one out from
  // under it would bill on dates with no invoice, and invoice on dates with
  // no payment.
  if (invoice.scheduleId && (await collectingFor(invoice.scheduleId)) > 0) {
    return failed("Auto-pay is on for this customer. Turn it off to change the repeat.");
  }

  const settings = {
    frequency: input.frequency,
    interval: input.interval,
    // New settings start a new rhythm, anchored on the date just chosen.
    anchorDate: next,
    nextIssueDate: next,
    endDate: end,
    autoSend: input.autoSend,
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
    summary:
      `Invoice ${invoice.number} set to repeat ${rhythm}, next on ${format(next, "MMM d, yyyy")}` +
      (input.autoSend ? ", sent to the client by itself" : ""),
  });

  const dueNow = next <= endOfDay(new Date());
  const made = dueNow
    ? await draftDueInvoices({ organizationId: org.id, scheduleId, actorId: user.id })
    : { drafted: [], failed: [] };
  const sending =
    dueNow && input.autoSend
      ? await sendScheduledInvoices({ organizationId: org.id, scheduleId })
      : { sent: [], failed: [] };

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoice.id}`);
  for (const draft of made.drafted) revalidatePath(`/invoices/${draft.id}`);

  if (made.failed.length > 0) {
    return saved(
      `Repeating ${rhythm}, but today's invoice could not be made. It will be tried again on the next morning run.`,
    );
  }

  const first = made.drafted[0];
  const when = format(next, "MMM d, yyyy");

  if (input.autoSend) {
    const sent = sending.sent[0];
    const notSent = sending.failed[0];
    // Saved either way: the repeat stands, and the draft is there to send.
    if (notSent) {
      return saved(
        `Repeating ${rhythm}. Today's invoice, ${notSent.number}, was made but not sent: ${notSent.error}`,
      );
    }
    return saved(
      sent
        ? `Repeating ${rhythm}. Today's invoice, ${sent.number}, was sent to ${sent.to}.`
        : `Repeating ${rhythm}. The next one is sent to the client on ${when}.`,
    );
  }

  return saved(
    first
      ? `Repeating ${rhythm}. Today's draft, ${first.number}, is ready to check.`
      : `Repeating ${rhythm}. The next draft is made on ${when}.`,
  );
}

const collectingFor = (scheduleId: string) =>
  prisma.autopaySubscription.count({
    where: { scheduleId, status: { in: COLLECTING_STATUSES } },
  });

export async function stopInvoiceRepeat(formData: FormData) {
  const { user, org } = await requirePermission("invoices:write");

  const id = String(formData.get("invoiceId") ?? "");
  if (!id) return;

  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true, number: true, scheduleId: true },
  });
  if (!invoice?.scheduleId) return;

  // Auto-pay has to be turned off first, where a refusal from PayPal can be
  // shown; the card offers no Stop while it is on. An invite not yet taken
  // up is withdrawn along with the repeat.
  if ((await collectingFor(invoice.scheduleId)) > 0) return;
  await turnOffAutopay({
    organizationId: org.id,
    scheduleId: invoice.scheduleId,
    actorId: user.id,
    reason: "The repeat was stopped.",
  });

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

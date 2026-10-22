import "server-only";

import { endOfDay } from "date-fns";

import { record } from "./activity";
import { entitlement } from "./billing/entitlement";
import { prisma } from "./db";
import { deliverInvoice } from "./invoice-delivery";
import { notify } from "./notifications";
import { whoHandlesBilling } from "./recurring-invoices";

/**
 * Send later.
 *
 * A draft given a day to go out on — by somebody choosing one, or by a repeat
 * that sends itself — is emailed to the client by the morning run on that
 * day, the same email the Send button writes.
 *
 * Each invoice is claimed before anything is sent: the day is cleared only if
 * it still holds the value that was read, so the morning run and a desktop
 * timer arriving together send it once between them. A send that fails is
 * not tried again tomorrow. The invoice stays a draft, and whoever chose the
 * day is told why, because a customer quietly billed a week late is worse
 * than a person told this morning.
 */

/** More than this in one run waits for the next; nobody is owed a flood. */
export const MAX_SENDS_PER_RUN = 200;

export type ScheduledSend = { id: string; number: string; organizationId: string; to: string };
export type FailedSend = { id: string; number: string; organizationId: string; error: string };

/**
 * Sends every draft whose day has come.
 *
 * What the morning run calls with no arguments, and what saving a repeat
 * that sends itself calls for its own schedule. Not for the demo, which must
 * look the same to every visitor, nor for a business that is locked — the
 * days wait for it to reopen.
 */
export async function sendScheduledInvoices(
  options: { now?: Date; organizationId?: string; scheduleId?: string } = {},
): Promise<{ sent: ScheduledSend[]; failed: FailedSend[] }> {
  const now = options.now ?? new Date();

  const due = await prisma.invoice.findMany({
    where: {
      status: "DRAFT",
      sendOn: { not: null, lte: endOfDay(now) },
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      organization: { isDemo: false },
    },
    select: {
      id: true,
      number: true,
      organizationId: true,
      scheduleId: true,
      sendOn: true,
      sendTo: true,
      sendScheduledById: true,
      client: { select: { displayName: true } },
    },
    orderBy: { sendOn: "asc" },
    take: MAX_SENDS_PER_RUN,
  });

  const orgs = new Map(
    (
      await prisma.organization.findMany({
        where: { id: { in: [...new Set(due.map((row) => row.organizationId))] } },
      })
    )
      .filter((org) => entitlement(org, now).ok)
      .map((org) => [org.id, org]),
  );

  const sent: ScheduledSend[] = [];
  const failed: FailedSend[] = [];

  for (const row of due) {
    const org = orgs.get(row.organizationId);
    if (!org) continue;

    const claimed = await prisma.invoice.updateMany({
      where: { id: row.id, status: "DRAFT", sendOn: row.sendOn },
      data: { sendOn: null },
    });
    if (claimed.count === 0) continue;

    // Auto-pay switched on after this was set: PayPal is charging for it, so
    // there is nothing to send and nobody to trouble about it.
    if (row.scheduleId && (await charging(row.scheduleId)) > 0) continue;

    let error: string;
    try {
      const result = await deliverInvoice(org, row.id, {
        to: row.sendTo,
        actorId: null,
        mustDeliver: true,
      });
      if (result.ok) {
        sent.push({ id: row.id, number: row.number, organizationId: org.id, to: result.to });
        continue;
      }
      error = result.error;
    } catch (thrown) {
      console.error(`[send later] could not send invoice ${row.id}`, thrown);
      error = "Something went wrong sending it.";
    }

    failed.push({ id: row.id, number: row.number, organizationId: org.id, error });
    await tellNotSent(org.id, row, error);
  }

  return { sent, failed };
}

const charging = (scheduleId: string) =>
  prisma.autopaySubscription.count({
    where: { scheduleId, status: { in: ["ACTIVE", "APPROVED"] } },
  });

async function tellNotSent(
  organizationId: string,
  invoice: {
    id: string;
    number: string;
    sendScheduledById: string | null;
    client: { displayName: string };
  },
  error: string,
) {
  await notify({
    organizationId,
    userIds: await whoHandlesBilling(organizationId, invoice.sendScheduledById),
    type: "INVOICE_NOT_SENT",
    title: `Invoice ${invoice.number} for ${invoice.client.displayName} was not sent`,
    body: `It was set to go today. ${error} It is still a draft: put that right, then send it.`,
    entityType: "invoice",
    entityId: invoice.id,
    actionUrl: `/invoices/${invoice.id}`,
  });

  await record({
    organizationId,
    userId: null,
    action: "invoice.not-sent",
    entityType: "INVOICE",
    entityId: invoice.id,
    summary: `Invoice ${invoice.number} was not sent on its day: ${error}`,
  });
}

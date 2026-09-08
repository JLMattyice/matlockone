"use server";

import { revalidatePath } from "next/cache";

import { saved, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { publicUrl } from "@/lib/messaging";
import { attachPaymentLink } from "@/lib/payments/link";
import { notify, notifyClientByEmail } from "@/lib/notifications";
import { formatMoney } from "@/lib/money";

/** Invoices falling due inside this many days get a courtesy reminder. */
const DUE_SOON_DAYS = 3;

/**
 * Chases unpaid invoices.
 *
 * Run from the Invoices screen today. It is written as a plain action with no
 * request-specific state so a scheduled task can call it on a timer later
 * without any change — the work is the same either way.
 *
 * Sending twice on the same day is prevented by checking the outbox rather than
 * a flag on the invoice, so the record of what was actually sent is the thing
 * that decides.
 */
export async function sendInvoiceReminders(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("invoices:send");

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const dueSoonCutoff = new Date(
    startOfToday.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000,
  );

  const candidates = await prisma.invoice.findMany({
    where: {
      organizationId: org.id,
      status: { in: ["SENT", "VIEWED"] },
      balanceCents: { gt: 0 },
      dueDate: { not: null, lte: dueSoonCutoff },
    },
    select: {
      id: true,
      number: true,
      dueDate: true,
      balanceCents: true,
      publicToken: true,
      createdById: true,
      // Needed to attach a pay link to the reminder.
      title: true,
      status: true,
      paymentUrl: true,
      client: { select: { displayName: true, email: true } },
    },
    orderBy: { dueDate: "asc" },
    take: 100,
  });

  if (candidates.length === 0) {
    return saved("Nothing to chase — no invoices are due or overdue.");
  }

  // Anything already chased today is skipped, so pressing the button twice
  // does not send the client two emails.
  const alreadySent = await prisma.outboxMessage.findMany({
    where: {
      organizationId: org.id,
      relatedType: "invoice",
      relatedId: { in: candidates.map((c) => c.id) },
      createdAt: { gte: startOfToday },
      subject: { contains: "reminder" },
    },
    select: { relatedId: true },
  });
  const chased = new Set(alreadySent.map((m) => m.relatedId));

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);

  let sent = 0;
  let skipped = 0;

  for (const invoice of candidates) {
    if (chased.has(invoice.id)) {
      skipped++;
      continue;
    }

    const overdue = invoice.dueDate! < startOfToday;
    const link = publicUrl(`/share/invoice/${invoice.publicToken}`);
    const due = invoice.dueDate!.toDateString();

    // A reminder that gives no way to pay is just a complaint. Reuses the link
    // the invoice already has, and asks for one otherwise.
    const linked = await attachPaymentLink(org, invoice);
    const payLines = linked.ok ? [`Pay online: ${linked.url}`, ""] : [];

    await notifyClientByEmail({
      organizationId: org.id,
      to: invoice.client.email,
      toName: invoice.client.displayName,
      subject: overdue
        ? `Overdue reminder — invoice ${invoice.number}`
        : `Payment reminder — invoice ${invoice.number}`,
      body: [
        `Hi ${invoice.client.displayName},`,
        "",
        overdue
          ? `Invoice ${invoice.number} for ${money(invoice.balanceCents)} was due on ${due} and is still outstanding.`
          : `A reminder that invoice ${invoice.number} for ${money(invoice.balanceCents)} is due on ${due}.`,
        "",
        ...payLines,
        `View it online: ${link}`,
        "",
        "If you have already sent payment, please ignore this.",
        "",
        "Thank you,",
        org.name,
      ].join("\n"),
      relatedType: "invoice",
      relatedId: invoice.id,
      createdById: user.id,
    });

    await notify({
      organizationId: org.id,
      userIds: invoice.createdById ? [invoice.createdById] : [],
      exceptUserId: user.id,
      type: overdue ? "INVOICE_OVERDUE" : "INVOICE_DUE",
      title: overdue
        ? `${invoice.number} is overdue`
        : `${invoice.number} is due soon`,
      body: `${money(invoice.balanceCents)} from ${invoice.client.displayName}`,
      entityType: "invoice",
      entityId: invoice.id,
      actionUrl: `/invoices/${invoice.id}`,
    });

    sent++;
  }

  revalidatePath("/invoices");
  revalidatePath("/", "layout");

  if (sent === 0) {
    return saved(`Already chased today — ${skipped} skipped.`);
  }

  return saved(
    skipped > 0
      ? `${sent} reminder${sent === 1 ? "" : "s"} sent, ${skipped} already chased today.`
      : `${sent} reminder${sent === 1 ? "" : "s"} sent.`,
  );
}

export async function reminderCandidateCount(): Promise<number> {
  const { org } = await requirePermission("invoices:read");

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const cutoff = new Date(
    startOfToday.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000,
  );

  return prisma.invoice.count({
    where: {
      organizationId: org.id,
      status: { in: ["SENT", "VIEWED"] },
      balanceCents: { gt: 0 },
      dueDate: { not: null, lte: cutoff },
    },
  });
}

"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { offerAutopay, syncAutopay, turnOffAutopay } from "@/lib/autopay";
import { prisma } from "@/lib/db";
import { publicUrl, sendMessage } from "@/lib/messaging";
import { formatMoney } from "@/lib/money";
import { describeRecurrence } from "@/lib/recurrence";

/**
 * Auto-pay, from the invoice page: offering it, sending the invite, looking
 * at PayPal now rather than tomorrow morning, and turning it off.
 *
 * The work is in src/lib/autopay.ts. These check who is asking and which
 * series they mean, and say what happened.
 */

/** The series an invoice belongs to, in this business. */
async function seriesOf(organizationId: string, invoiceId: string | null) {
  if (!invoiceId) return null;

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: { id: true, scheduleId: true },
  });
  if (!invoice?.scheduleId) return null;

  return { invoiceId: invoice.id, scheduleId: invoice.scheduleId };
}

function refresh(invoiceId: string) {
  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
}

export async function offerInvoiceAutopay(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("invoices:write");

  const series = await seriesOf(org.id, text(formData, "invoiceId"));
  if (!series) return failed("Set this invoice to repeat first.");

  const offered = await offerAutopay({
    organization: org,
    scheduleId: series.scheduleId,
    actorId: user.id,
  });
  if (!offered.ok) return failed(offered.error);

  refresh(series.invoiceId);
  return saved("Auto-pay is ready to offer. Send the invite to your customer.");
}

export async function emailAutopayInvite(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("invoices:send");

  const series = await seriesOf(org.id, text(formData, "invoiceId"));
  if (!series) return failed("Set this invoice to repeat first.");

  const schedule = await prisma.invoiceSchedule.findUnique({
    where: { id: series.scheduleId },
    include: {
      invoices: {
        where: { status: { not: "CANCELLED" } },
        orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: { title: true, number: true, client: { select: { displayName: true, email: true } } },
      },
    },
  });
  const latest = schedule?.invoices[0];
  if (!schedule?.autopayToken || !schedule.autopayAmountCents || !latest) {
    return failed("Offer auto-pay first.");
  }

  const to = text(formData, "email") ?? latest.client.email;
  if (!to) {
    return {
      ok: false,
      fieldErrors: { email: "This customer has no email address. Add one, or enter one here." },
    };
  }

  const link = publicUrl(`/share/autopay/${schedule.autopayToken}`);
  const amount = formatMoney(schedule.autopayAmountCents, org.currency, org.locale);
  const what = latest.title ?? `invoice ${latest.number}`;

  const result = await sendMessage({
    organizationId: org.id,
    channel: "EMAIL",
    to,
    toName: latest.client.displayName,
    subject: `Pay ${org.name} automatically`,
    body: [
      `Hi ${latest.client.displayName},`,
      "",
      `You can now pay for ${what} automatically — ${amount} ${describeRecurrence(schedule).toLowerCase()} through PayPal — instead of paying each invoice by hand.`,
      "",
      `Set it up here. It takes a minute, on PayPal's own site: ${link}`,
      "",
      "You can cancel it any time from your PayPal account.",
      "",
      "Thank you,",
      org.name,
    ].join("\n"),
    relatedType: "invoice",
    relatedId: series.invoiceId,
    createdById: user.id,
  });

  if (!result.ok) return failed(result.error ?? "Could not send the invite.");

  if (!result.delivered) {
    return saved(
      `Saved to the outbox. Connect an email account under Settings → Email to deliver it to ${to}.`,
    );
  }
  return saved(`Invite sent to ${to}.`);
}

export async function checkInvoiceAutopay(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("payments:record");

  const series = await seriesOf(org.id, text(formData, "invoiceId"));
  if (!series) return failed("This invoice is not repeating.");

  const outcome = await syncAutopay({ organizationId: org.id, scheduleId: series.scheduleId });

  refresh(series.invoiceId);
  revalidatePath("/payments");

  if (outcome.failed.length > 0) {
    return failed("PayPal did not answer. Try again in a little while.");
  }
  if (outcome.collected > 0) {
    return saved(
      `${outcome.collected} payment${outcome.collected === 1 ? "" : "s"} recorded from PayPal.`,
    );
  }
  return saved("Checked with PayPal — nothing new.");
}

export async function turnOffInvoiceAutopay(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("invoices:write");

  const series = await seriesOf(org.id, text(formData, "invoiceId"));
  if (!series) return failed("This invoice is not repeating.");

  const off = await turnOffAutopay({
    organizationId: org.id,
    scheduleId: series.scheduleId,
    actorId: user.id,
    reason: `${org.name} turned auto-pay off.`,
  });
  if (!off.ok) return failed(off.error);

  refresh(series.invoiceId);
  return saved("Auto-pay is off. PayPal will not charge this customer again.");
}

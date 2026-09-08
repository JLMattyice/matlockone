"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { recordRemotePayments, resolveProcessor } from "@/lib/payments/account";
import { attachPaymentLink } from "@/lib/payments/link";
import { PAYMENT_PROVIDER_META } from "@/lib/payments/catalog";
import { notify } from "@/lib/notifications";

/**
 * Putting a Pay now link on an invoice, and asking the processor what has been
 * paid against it.
 *
 * Kept out of invoices/actions.ts because that file is already the largest in
 * the app, and because these two are the only invoice actions that talk to
 * something outside the building.
 */

async function loadInvoice(organizationId: string, id: string) {
  return prisma.invoice.findFirst({
    where: { id, organizationId },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      balanceCents: true,
      totalCents: true,
      clientId: true,
      createdById: true,
      paymentUrl: true,
      paymentRef: true,
      paymentProvider: true,
      client: { select: { displayName: true, email: true } },
    },
  });
}

export async function createPaymentLink(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("invoices:write");

  const id = String(formData.get("invoiceId") ?? "");
  const invoice = await loadInvoice(org.id, id);
  if (!invoice) return failed("That invoice no longer exists.");

  if (invoice.status === "CANCELLED") {
    return failed("This invoice has been cancelled.");
  }
  if (invoice.status === "DRAFT") {
    // Matches the rule recordPayment already enforces. recalculateInvoice
    // deliberately will not move a draft to PAID, so money arriving against
    // one leaves it settled-but-still-draft — paid in full with a zero balance
    // and a Draft badge. Better to refuse than to create that state.
    return failed("Send the invoice before adding a payment link to it.");
  }
  if (invoice.balanceCents <= 0) {
    return failed("This invoice has nothing left to pay.");
  }

  // Same call sending makes, so the button and the email cannot drift apart.
  const linked = await attachPaymentLink(org, invoice);

  if (!linked.ok) {
    return failed(
      linked.reason === "no-processor"
        ? "No payment processor is connected. Set one up under Settings → Payments."
        : linked.reason === "failed"
          ? linked.error
          : "This invoice cannot take a payment link.",
    );
  }

  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath("/invoices");

  return saved(
    linked.alreadyHad
      ? "This invoice already has a Pay now link."
      : "Pay now link added. It goes out with the invoice next time you send it.",
  );
}

export async function removePaymentLink(formData: FormData) {
  const { org } = await requirePermission("invoices:write");

  const id = String(formData.get("invoiceId") ?? "");
  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true },
  });
  if (!invoice) return;

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      paymentUrl: null,
      paymentRef: null,
      paymentProvider: null,
      paymentLinkedAt: null,
      paymentCheckedAt: null,
    },
  });

  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath("/invoices");
}

/**
 * Asks the processor what has settled, and records anything new.
 *
 * Polling rather than webhooks: a webhook needs an address the processor can
 * reach, and the desktop build has none. Safe to run repeatedly — each payment
 * is stored under the processor's own transaction id behind a unique index.
 */
export async function checkForPayment(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org, user } = await requirePermission("payments:record");

  const id = String(formData.get("invoiceId") ?? "");
  const invoice = await loadInvoice(org.id, id);
  if (!invoice) return failed("That invoice no longer exists.");

  const processor = await resolveProcessor(org.id);
  if (!processor) {
    return failed(
      "No payment processor is connected. Set one up under Settings → Payments.",
    );
  }

  if (invoice.status === "DRAFT") {
    return failed("Send the invoice before recording payments against it.");
  }

  const meta = PAYMENT_PROVIDER_META[processor.provider];
  if (!meta.reconciles) {
    return failed(
      `${meta.label} cannot tell Matlock One what it collected. Record the payment by hand once it lands.`,
    );
  }

  const result = await processor.adapter.listPayments(
    invoice.paymentRef,
    processor.config,
    processor.credentials,
  );

  if (!result.ok) return failed(result.error);

  const outcome = await recordRemotePayments({
    organizationId: org.id,
    invoiceId: invoice.id,
    clientId: invoice.clientId,
    provider: processor.provider,
    payments: result.value,
  });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { paymentCheckedAt: new Date() },
  });

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);

  if (outcome.recorded > 0) {
    await notify({
      organizationId: org.id,
      userIds: invoice.createdById ? [invoice.createdById] : [],
      exceptUserId: user.id,
      type: "PAYMENT_RECEIVED",
      title: `${money(outcome.amountCents)} received on ${invoice.number}`,
      body: outcome.settled
        ? "Paid in full."
        : `${money(outcome.balanceCents)} still outstanding.`,
      entityType: "invoice",
      entityId: invoice.id,
      actionUrl: `/invoices/${invoice.id}`,
    });
  }

  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath("/invoices");
  revalidatePath("/payments");

  if (outcome.recorded === 0) {
    return saved(`Nothing new — ${meta.label} reports no further payments.`);
  }

  return saved(
    outcome.settled
      ? `${money(outcome.amountCents)} recorded — invoice paid in full.`
      : `${money(outcome.amountCents)} recorded. ${money(outcome.balanceCents)} still outstanding.`,
  );
}

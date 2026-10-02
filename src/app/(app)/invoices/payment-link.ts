"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { attachPaymentLink } from "@/lib/payments/link";
import { reconcileInvoice } from "@/lib/payments/reconcile";

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
      publicToken: true,
      title: true,
      status: true,
      balanceCents: true,
      amountPaidCents: true,
      totalCents: true,
      clientId: true,
      createdById: true,
      paymentUrl: true,
      paymentRef: true,
      paymentProvider: true,
      paymentLinkCents: true,
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
          : linked.reason === "stale"
            ? "The Pay now link on this invoice asks for a different amount from what is owed now. Remove it first, then add a new one."
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
      paymentLinkCents: null,
    },
  });

  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath("/invoices");
}

/**
 * Asks the processor what has settled, and records anything new.
 *
 * The same check PayPal's notices and the morning run make, so a payment found
 * by pressing this is announced and acted on exactly as one found by either of
 * them. Safe to run repeatedly — each payment is stored under the processor's
 * own transaction id behind a unique index.
 */
export async function checkForPayment(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org, user } = await requirePermission("payments:record");

  const id = String(formData.get("invoiceId") ?? "");
  const outcome = await reconcileInvoice({
    organizationId: org.id,
    invoiceId: id,
    userId: user.id,
  });

  if (!outcome.ok) return failed(outcome.error);

  revalidatePath(`/invoices/${id}`);
  revalidatePath("/invoices");
  revalidatePath("/payments");
  revalidatePath("/tasks");

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);

  if (outcome.recorded === 0) {
    return saved(`Nothing new — ${outcome.providerLabel} reports no further payments.`);
  }

  return saved(
    outcome.settled
      ? `${money(outcome.amountCents)} recorded — invoice paid in full.`
      : `${money(outcome.amountCents)} recorded. ${money(outcome.balanceCents)} still outstanding.`,
  );
}

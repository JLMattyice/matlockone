import "server-only";

import { record } from "./activity";
import { prisma } from "./db";
import { publicUrl, resolveEmailAccount, sendMessage } from "./messaging";
import { formatMoney } from "./money";
import { attachPaymentLink } from "./payments/link";
import { invoicePdfFor } from "./pdf/invoice-document";
import { portalLine } from "./portal";
import { sendToQuickBooksSoon } from "./quickbooks/sync";
import type { Organization } from "@/generated/prisma/client";

/**
 * Emailing an invoice to the client.
 *
 * One path whether somebody pressed Send or the morning run is sending a
 * draft on the day it was set to go, so the two can never come to write
 * different emails.
 */

export type Delivery =
  | { ok: false; error: string; field?: "email" }
  | {
      ok: true;
      to: string;
      number: string;
      /** False when no email account is connected: saved to the outbox only. */
      delivered: boolean;
      payUrl: string | null;
      /** The processor was asked for a Pay now link and refused, saying this. */
      linkRefused: string | null;
    };

export async function deliverInvoice(
  org: Organization,
  invoiceId: string,
  options: {
    /** The address to use; the client's own when not given. */
    to?: string | null;
    /** Who is sending it; null for the morning run. */
    actorId: string | null;
    /**
     * Refuse rather than save it to the outbox when no email account is
     * connected. Somebody pressing Send is told it was only saved; nobody is
     * watching the morning run, so it must not mark sent what never left.
     */
    mustDeliver?: boolean;
  },
): Promise<Delivery> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId: org.id },
    include: {
      client: { select: { displayName: true, email: true } },
      _count: { select: { lineItems: true } },
    },
  });
  if (!invoice) return { ok: false, error: "That invoice no longer exists." };
  if (invoice._count.lineItems === 0) {
    return { ok: false, error: "Add at least one line before sending." };
  }
  if (invoice.status === "CANCELLED") {
    return { ok: false, error: "This invoice has been cancelled." };
  }

  const to = options.to?.trim() || invoice.client.email;
  if (!to) {
    return {
      ok: false,
      field: "email",
      error: "This client has no email address. Add one, or enter one here.",
    };
  }

  if (options.mustDeliver && !(await resolveEmailAccount(org.id))) {
    return {
      ok: false,
      error: "No email account is connected. Connect one under Settings → Email.",
    };
  }

  const link = publicUrl(`/share/invoice/${invoice.publicToken}`);
  const amount = formatMoney(invoice.balanceCents, org.currency, org.locale);

  // The Pay now link goes first when there is one. It is hosted by the
  // processor, so unlike the share link above it works from anywhere — which
  // on the desktop build is often the only address the client can open.
  //
  // Attached here rather than left to a separate button. An invoice email that
  // cannot be paid from is most of the point of sending it, and remembering to
  // press "Add pay link" first is not a workflow anybody keeps up.
  //
  // A processor that is not connected, or an invoice in a state that cannot
  // take money, is not an error: the invoice still goes out, just without the
  // line. Only a processor that was asked and refused is worth reporting.
  const linked =
    invoice.status === "DRAFT"
      ? // Sending is what promotes a draft to SENT, a few lines below. Ask for
        // the link as though that had already happened.
        await attachPaymentLink(org, { ...invoice, status: "SENT" })
      : await attachPaymentLink(org, invoice);

  const payUrl = linked.ok ? linked.url : null;
  const payLines = payUrl ? [`Pay online: ${payUrl}`, ""] : [];

  // The invoice itself, so the client keeps the document rather than only a
  // link — and so it is still readable in their inbox years later, when no
  // link is going to resolve. Built after the pay link is attached, so the
  // PDF carries that too.
  //
  // A failure here must not stop the invoice going out. A plain email with a
  // pay link is still a working invoice; sending nothing would be far worse
  // than sending it without the file.
  let attachments;
  try {
    const document = await invoicePdfFor(org, invoice.id);
    if (document) {
      attachments = [
        {
          filename: document.filename,
          content: document.bytes,
          contentType: "application/pdf",
        },
      ];
    }
  } catch {
    attachments = undefined;
  }

  const result = await sendMessage({
    organizationId: org.id,
    channel: "EMAIL",
    to,
    toName: invoice.client.displayName,
    attachments,
    subject: `Invoice ${invoice.number} from ${org.name}`,
    body: [
      `Hi ${invoice.client.displayName},`,
      "",
      `Invoice ${invoice.number} for ${amount} is attached.`,
      invoice.dueDate
        ? `Payment is due by ${invoice.dueDate.toDateString()}.`
        : "",
      "",
      ...payLines,
      `View it online: ${link}`,
      "",
      ...(await portalLine(invoice.clientId)),
      "Thank you,",
      org.name,
    ].join("\n"),
    relatedType: "invoice",
    relatedId: invoice.id,
    createdById: options.actorId,
  });

  if (!result.ok) return { ok: false, error: result.error ?? "Could not send that invoice." };

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: invoice.status === "DRAFT" ? "SENT" : invoice.status,
      sentAt: invoice.sentAt ?? new Date(),
      // Sent now, so not again on the day it was set to go.
      sendOn: null,
      sendTo: null,
      sendScheduledById: null,
    },
  });

  await record({
    organizationId: org.id,
    userId: options.actorId,
    action: "invoice.sent",
    entityType: "INVOICE",
    entityId: invoice.id,
    summary: options.actorId
      ? `Invoice ${invoice.number} sent to ${to}`
      : `Invoice ${invoice.number} sent to ${to} on the day it was set to go`,
    metadata: { payLink: Boolean(payUrl) },
  });

  await sendToQuickBooksSoon(org.id, { invoices: [invoice.id] });

  return {
    ok: true,
    to,
    number: invoice.number,
    delivered: result.delivered,
    payUrl,
    linkRefused: !linked.ok && linked.reason === "failed" ? linked.error : null,
  };
}

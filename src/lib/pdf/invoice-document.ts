import "server-only";

import { prisma } from "@/lib/db";
import { buildInvoicePdf } from "./invoice-pdf";
import type { Organization } from "@/generated/prisma/client";

/**
 * The database row an invoice PDF is drawn from.
 *
 * Kept separate from the drawing code so that file stays a pure function of its
 * input — which is what makes the layout testable without a database.
 */
export async function invoicePdfFor(org: Organization, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId: org.id },
    include: {
      client: { select: { displayName: true, email: true, phone: true } },
      address: true,
      lineItems: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!invoice) return null;

  const bytes = await buildInvoicePdf({
    organization: {
      name: org.name,
      legalName: org.legalName,
      email: org.email,
      phone: org.phone,
      website: org.website,
      addressLine1: org.addressLine1,
      addressLine2: org.addressLine2,
      city: org.city,
      state: org.state,
      postalCode: org.postalCode,
      currency: org.currency,
      locale: org.locale,
      primaryColor: org.primaryColor,
      invoiceFooter: org.invoiceFooter,
    },
    invoice: {
      number: invoice.number,
      title: invoice.title,
      status: invoice.status,
      // No issue date column: an invoice is issued when it is sent, and a
      // draft that has never been sent shows the day it was drawn up.
      issuedAt: invoice.sentAt ?? invoice.createdAt,
      dueDate: invoice.dueDate,
      subtotalCents: invoice.subtotalCents,
      taxCents: invoice.taxCents,
      discountCents: invoice.discountCents,
      totalCents: invoice.totalCents,
      amountPaidCents: invoice.amountPaidCents,
      balanceCents: invoice.balanceCents,
      notes: invoice.notes,
      paymentUrl: invoice.paymentUrl,
    },
    client: invoice.client,
    address: invoice.address,
    lineItems: invoice.lineItems.map((item) => ({
      name: item.name,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unitPriceCents: item.unitPriceCents,
      totalCents: item.totalCents,
    })),
  });

  return { bytes, filename: `${invoice.number}.pdf` };
}

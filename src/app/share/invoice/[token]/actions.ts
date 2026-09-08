"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";

/**
 * The public invoice link is read-only: a client can look at it and print it,
 * but nothing here changes money. The only write is the first-open timestamp,
 * and it is guarded the same way the estimate link is.
 */
export async function markInvoiceViewed(token: string) {
  if (!token) return;

  const invoice = await prisma.invoice.findUnique({
    where: { publicToken: token },
    select: { id: true, status: true, viewedAt: true },
  });
  if (!invoice) return;

  // Only the first open, and only for an invoice that has actually been sent.
  if (invoice.viewedAt || invoice.status !== "SENT") return;

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "VIEWED", viewedAt: new Date() },
  });

  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath("/invoices");
}

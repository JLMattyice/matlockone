"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { shareAllowed, shareMissed } from "@/lib/share-guard";

/**
 * The public invoice link is read-only: a client can look at it and print it,
 * but nothing here changes money. The only write is the first-open timestamp,
 * and it is guarded the same way the estimate link is.
 */
export async function markInvoiceViewed(token: string) {
  if (!token) return;

  // A server action is callable with any token, not only from the page, so it
  // carries the same limit as the page does.
  if (!(await shareAllowed()).ok) return;

  const invoice = await prisma.invoice.findUnique({
    where: { publicToken: token },
    select: { id: true, status: true, viewedAt: true },
  });
  if (!invoice) {
    await shareMissed();
    return;
  }

  // Only the first open, and only for an invoice that has actually been sent.
  if (invoice.viewedAt || invoice.status !== "SENT") return;

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "VIEWED", viewedAt: new Date() },
  });

  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath("/invoices");
}

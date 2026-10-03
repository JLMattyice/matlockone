import "server-only";

import type { QuickBooksConnection } from "./connection";
import { fallbackItem, itemForLine, type PriceBookEntry } from "./items";
import type { Link } from "./links";
import { createRemote, isGone, retireRemote, updateRemote } from "./records";
import { formatIn } from "../time-zone";

/**
 * An invoice here as a QuickBooks Online invoice.
 *
 * The owner chose to send sales tax as its own line rather than let
 * QuickBooks calculate it, so every total there is exactly what the customer
 * was billed. Every line is therefore marked non-taxable for a US company —
 * otherwise QuickBooks' automated sales tax would add its own on top. A
 * discount goes the same way, as a negative line.
 */

export type InvoiceForQuickBooks = {
  id: string;
  number: string;
  status: string;
  issueDate: Date;
  dueDate: Date | null;
  notes: string | null;
  discountCents: number;
  taxCents: number;
  /** A final invoice's earlier stages, taken off after tax. */
  creditCents: number;
  creditLabel: string | null;
  client: { email: string | null };
  lineItems: {
    kind: string;
    name: string;
    description: string | null;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    sortOrder: number;
  }[];
};

/** Dollars as QuickBooks takes them: a number with two decimals. */
export function dollars(cents: number) {
  return Math.round(cents) / 100;
}

/** A calendar day in the business's own time zone, as QuickBooks writes dates. */
export function dayOf(date: Date, zone: string) {
  return formatIn(date, "yyyy-MM-dd", zone);
}

function isUs(connection: QuickBooksConnection) {
  return !connection.country || /^(us|usa|united states)/i.test(connection.country);
}

type QboLine = {
  DetailType: "SalesItemLineDetail";
  Amount: number;
  Description?: string;
  SalesItemLineDetail: {
    ItemRef: { value: string };
    Qty?: number;
    UnitPrice?: number;
    TaxCodeRef?: { value: string };
  };
};

async function linesFor(
  connection: QuickBooksConnection,
  invoice: InvoiceForQuickBooks,
  book: Map<string, PriceBookEntry>,
): Promise<QboLine[]> {
  const us = isUs(connection);
  const line = (itemId: string, cents: number, description?: string, qty?: number, unitCents?: number): QboLine => ({
    DetailType: "SalesItemLineDetail",
    Amount: dollars(cents),
    ...(description ? { Description: description.slice(0, 4000) } : {}),
    SalesItemLineDetail: {
      ItemRef: { value: itemId },
      ...(qty !== undefined && unitCents !== undefined ? { Qty: qty, UnitPrice: dollars(unitCents) } : {}),
      ...(us ? { TaxCodeRef: { value: "NON" } } : {}),
    },
  });

  const lines: QboLine[] = [];
  for (const item of [...invoice.lineItems].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const itemId = await itemForLine(connection, item, book);
    const description = [item.name, item.description].filter(Boolean).join("\n");
    // QuickBooks checks Amount = Qty × UnitPrice. A quantity like 1.333 hours
    // rounds differently here, so such a line goes as its amount alone.
    const exact = Math.abs(item.quantity * item.unitPriceCents - item.totalCents) < 0.5;
    lines.push(
      exact
        ? line(itemId, item.totalCents, description, item.quantity, item.unitPriceCents)
        : line(itemId, item.totalCents, description),
    );
  }

  if (invoice.discountCents > 0) {
    lines.push(line(await fallbackItem(connection, "DISCOUNT"), -invoice.discountCents, "Discount"));
  }
  if (invoice.taxCents > 0) {
    lines.push(line(await fallbackItem(connection, "SALES_TAX"), invoice.taxCents, "Sales tax"));
  }
  if (invoice.creditCents > 0) {
    lines.push(
      line(
        await fallbackItem(connection, "PRIOR_BILLING"),
        -invoice.creditCents,
        invoice.creditLabel ?? "Previously billed",
      ),
    );
  }
  return lines;
}

export type RemoteOutcome = {
  externalId: string | null;
  syncToken: string | null;
  remoteStatus: "ACTIVE" | "VOIDED" | "DELETED";
};

/**
 * Sends one invoice that has left draft: made, or updated in place. A
 * cancelled one is voided there — kept in the books as a zero, as
 * QuickBooks does. One reinstated after voiding is made again, since a
 * voided invoice cannot be brought back.
 */
export async function pushInvoice(
  connection: QuickBooksConnection,
  invoice: InvoiceForQuickBooks,
  link: Link | null,
  customerId: string,
  book: Map<string, PriceBookEntry>,
  zone: string,
): Promise<RemoteOutcome> {
  const live = link?.externalId && link.remoteStatus === "ACTIVE" ? link : null;

  if (invoice.status === "CANCELLED") {
    if (!live) return { externalId: link?.externalId ?? null, syncToken: link?.syncToken ?? null, remoteStatus: "VOIDED" };
    const voided = await retireRemote(connection, "invoice", "void", live.externalId!, live.syncToken);
    return { externalId: live.externalId, syncToken: voided?.SyncToken ?? null, remoteStatus: "VOIDED" };
  }

  const body = {
    CustomerRef: { value: customerId },
    DocNumber: invoice.number.slice(0, 21),
    TxnDate: dayOf(invoice.issueDate, zone),
    ...(invoice.dueDate ? { DueDate: dayOf(invoice.dueDate, zone) } : {}),
    ...(invoice.client.email ? { BillEmail: { Address: invoice.client.email.slice(0, 100) } } : {}),
    ...(invoice.notes ? { CustomerMemo: { value: invoice.notes.slice(0, 1000) } } : {}),
    PrivateNote: "Sent from Matlock One.",
    ...(isUs(connection) ? {} : { GlobalTaxCalculation: "NotApplicable" }),
    Line: await linesFor(connection, invoice, book),
  };

  if (live) {
    try {
      const updated = await updateRemote(connection, "invoice", live.externalId!, live.syncToken, body);
      return { externalId: updated.Id, syncToken: updated.SyncToken, remoteStatus: "ACTIVE" };
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  const created = await createRemote(connection, "invoice", body);
  return { externalId: created.Id, syncToken: created.SyncToken, remoteStatus: "ACTIVE" };
}

/** An invoice deleted here: voided there, so its number stays accounted for. */
export async function voidDeletedInvoice(connection: QuickBooksConnection, link: Link) {
  if (!link.externalId || link.remoteStatus !== "ACTIVE") return;
  await retireRemote(connection, "invoice", "void", link.externalId, link.syncToken);
}

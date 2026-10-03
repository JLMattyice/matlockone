import "server-only";

import type { QuickBooksConnection } from "./connection";
import { dayOf, dollars, type RemoteOutcome } from "./invoices";
import type { Link } from "./links";
import { createRemote, retireRemote } from "./records";
import { PAYMENT_METHOD_LABELS, isPaymentMethod } from "../constants";

/**
 * A payment here as a QuickBooks Online payment, applied to its invoice.
 *
 * No deposit account is named, so QuickBooks puts it in Undeposited Funds —
 * the owner's choice, and QuickBooks' own default: the accountant groups
 * payments into the real bank deposit there. A payment never changes here
 * once recorded, so it is sent once; deleting it here deletes it there.
 */

export type PaymentForQuickBooks = {
  id: string;
  amountCents: number;
  method: string;
  receivedAt: Date;
  reference: string | null;
};

export async function pushPayment(
  connection: QuickBooksConnection,
  payment: PaymentForQuickBooks,
  customerId: string,
  invoiceId: string,
  zone: string,
): Promise<RemoteOutcome> {
  const amount = dollars(payment.amountCents);
  const method = isPaymentMethod(payment.method) ? PAYMENT_METHOD_LABELS[payment.method] : payment.method;

  const created = await createRemote(connection, "payment", {
    CustomerRef: { value: customerId },
    TotalAmt: amount,
    TxnDate: dayOf(payment.receivedAt, zone),
    ...(payment.reference ? { PaymentRefNum: payment.reference.slice(0, 21) } : {}),
    PrivateNote: `${method}, recorded in Matlock One.`,
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }] }],
  });
  return { externalId: created.Id, syncToken: created.SyncToken, remoteStatus: "ACTIVE" };
}

/** A payment deleted here: deleted there, which puts the invoice's balance back. */
export async function deleteRemovedPayment(connection: QuickBooksConnection, link: Link) {
  if (!link.externalId || link.remoteStatus !== "ACTIVE") return;
  await retireRemote(connection, "payment", "delete", link.externalId, link.syncToken);
}

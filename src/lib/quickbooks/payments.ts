import "server-only";

import type { QuickBooksConnection } from "./connection";
import { dayOf, dollars, type RemoteOutcome } from "./invoices";
import type { Link } from "./links";
import { createRemote, isGone, retireRemote, updateRemote } from "./records";
import { PAYMENT_METHOD_LABELS, isPaymentMethod } from "../constants";

/**
 * A payment here as a QuickBooks Online payment, applied to its invoice.
 *
 * No deposit account is named, so QuickBooks puts it in Undeposited Funds —
 * the owner's choice, and QuickBooks' own default: the accountant groups
 * payments into the real bank deposit there. A payment is sent once, again
 * only if somebody corrects it here (which updates the one already there),
 * and deleting it here deletes it there.
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
  link: Link | null,
  customerId: string,
  invoiceId: string,
  zone: string,
): Promise<RemoteOutcome> {
  const amount = dollars(payment.amountCents);
  const method = isPaymentMethod(payment.method) ? PAYMENT_METHOD_LABELS[payment.method] : payment.method;

  const body = {
    CustomerRef: { value: customerId },
    TotalAmt: amount,
    TxnDate: dayOf(payment.receivedAt, zone),
    ...(payment.reference ? { PaymentRefNum: payment.reference.slice(0, 21) } : {}),
    PrivateNote: `${method}, recorded in Matlock One.`,
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }] }],
  };

  const live = link?.externalId && link.remoteStatus === "ACTIVE" ? link : null;
  if (live) {
    try {
      // Blank rather than left out, so a reference cleared here is cleared
      // there: a sparse update keeps any field it is not given.
      const fields = { PaymentRefNum: "", ...body };
      const updated = await updateRemote(connection, "payment", live.externalId!, live.syncToken, fields);
      return { externalId: updated.Id, syncToken: updated.SyncToken, remoteStatus: "ACTIVE" };
    } catch (error) {
      // Deleted over there since: the corrected one goes in as new.
      if (!isGone(error)) throw error;
    }
  }

  const created = await createRemote(connection, "payment", body);
  return { externalId: created.Id, syncToken: created.SyncToken, remoteStatus: "ACTIVE" };
}

/** A payment deleted here: deleted there, which puts the invoice's balance back. */
export async function deleteRemovedPayment(connection: QuickBooksConnection, link: Link) {
  if (!link.externalId || link.remoteStatus !== "ACTIVE") return;
  await retireRemote(connection, "payment", "delete", link.externalId, link.syncToken);
}

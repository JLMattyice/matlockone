/**
 * Whether a stored pay link still asks for what is owed.
 *
 * A processor's link — a PayPal invoice, a Stripe invoice, a Square payment
 * link, a Shopify draft order — is made once, for the balance at that moment,
 * and nothing changes it afterwards. Record a $200 cash payment on a $500
 * invoice, or edit the invoice's lines, and the link goes on asking for $500.
 * Offering it then invites the client to pay the wrong amount, so every place
 * a link reaches a client asks here first: the invoice email, the reminders,
 * the client's invoice page and the PDF.
 *
 * Not "server-only": the client's invoice page and the PDF are drawn from the
 * same rule as the emails, and it needs nothing but the invoice's own columns.
 */

export type LinkedInvoice = {
  paymentUrl: string | null;
  /** Present for a link the processor made for a fixed amount. */
  paymentRef: string | null;
  /** What the link asks for; null for links made before it was recorded. */
  paymentLinkCents: number | null;
  balanceCents: number;
  amountPaidCents: number;
};

export function payLinkIsStale(invoice: LinkedInvoice): boolean {
  if (!invoice.paymentUrl || invoice.balanceCents <= 0) return false;

  // No processor-side request means no fixed amount: a pasted link (PayPal.Me,
  // a bank portal) asks for nothing in particular, and a Clover page is made
  // for the balance at the moment it is clicked.
  if (invoice.paymentRef === null) return false;

  if (invoice.paymentLinkCents !== null) {
    return invoice.paymentLinkCents !== invoice.balanceCents;
  }

  // Made before the amount was recorded. With nothing paid the balance is the
  // whole invoice, which is what it was made for unless the invoice was edited
  // since; once anything has been paid there is no telling, and a link that
  // might ask for the wrong amount is not offered.
  return invoice.amountPaidCents > 0;
}

/** The link to put in front of a client, or null for none. */
export function offeredPayLink(invoice: LinkedInvoice): string | null {
  if (!invoice.paymentUrl || invoice.balanceCents <= 0) return null;
  return payLinkIsStale(invoice) ? null : invoice.paymentUrl;
}

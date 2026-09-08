import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canTakePayment } from "@/lib/payments/link";

/**
 * Whether an invoice may carry a "Pay online" link.
 *
 * Sending an invoice now attaches one automatically, so this decides what a
 * client is invited to pay. Getting it wrong is not cosmetic: a link on a
 * cancelled invoice collects money for work that was called off, and a link on
 * a settled one collects it twice.
 */

describe("what can be paid", () => {
  const invoice = (over: Partial<{ status: string; balanceCents: number }> = {}) => ({
    status: "SENT",
    balanceCents: 100,
    ...over,
  });

  it("allows a sent invoice with a balance", () => {
    expect(canTakePayment(invoice())).toBe(true);
    expect(canTakePayment(invoice({ status: "OVERDUE" }))).toBe(true);
    expect(canTakePayment(invoice({ status: "PARTIAL" }))).toBe(true);
  });

  it("refuses a cancelled invoice", () => {
    // Money arriving against called-off work has to be refunded by hand.
    expect(canTakePayment(invoice({ status: "CANCELLED" }))).toBe(false);
  });

  it("refuses a draft", () => {
    // The balance recalculation deliberately will not move a draft to PAID, so
    // a payment against one leaves it settled-but-still-draft: zero balance,
    // paid in full, and a Draft badge that never clears.
    expect(canTakePayment(invoice({ status: "DRAFT" }))).toBe(false);
  });

  it("refuses an invoice with nothing left to pay", () => {
    expect(canTakePayment(invoice({ balanceCents: 0 }))).toBe(false);
    // A credit balance is somebody owed a refund, not somebody owing money.
    expect(canTakePayment(invoice({ balanceCents: -500 }))).toBe(false);
  });
});

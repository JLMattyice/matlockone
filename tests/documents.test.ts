import { describe, expect, it } from "vitest";

import {
  ageingBucket,
  effectiveEstimateStatus,
  effectiveInvoiceStatus,
  invoiceIsOpen,
  isEstimateOpen,
} from "@/lib/documents";

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY);

describe("effectiveEstimateStatus", () => {
  it("expires a sent estimate once its date passes", () => {
    expect(
      effectiveEstimateStatus({ status: "SENT", expiresAt: daysFromNow(-1) }),
    ).toBe("EXPIRED");

    expect(
      effectiveEstimateStatus({ status: "VIEWED", expiresAt: daysFromNow(-30) }),
    ).toBe("EXPIRED");
  });

  it("leaves a still-valid estimate alone", () => {
    expect(
      effectiveEstimateStatus({ status: "SENT", expiresAt: daysFromNow(5) }),
    ).toBe("SENT");

    expect(
      effectiveEstimateStatus({ status: "VIEWED", expiresAt: null }),
    ).toBe("VIEWED");
  });

  it("never expires an estimate the client already answered", () => {
    // A decision is a fact about what happened; the calendar cannot undo it.
    expect(
      effectiveEstimateStatus({ status: "ACCEPTED", expiresAt: daysFromNow(-90) }),
    ).toBe("ACCEPTED");

    expect(
      effectiveEstimateStatus({ status: "DECLINED", expiresAt: daysFromNow(-90) }),
    ).toBe("DECLINED");
  });

  it("never expires a draft, which was never sent", () => {
    expect(
      effectiveEstimateStatus({ status: "DRAFT", expiresAt: daysFromNow(-10) }),
    ).toBe("DRAFT");
  });

  it("falls back to DRAFT for an unrecognised stored value", () => {
    expect(
      effectiveEstimateStatus({ status: "NONSENSE", expiresAt: null }),
    ).toBe("DRAFT");
  });

  it("knows which statuses a client can still act on", () => {
    expect(isEstimateOpen("SENT")).toBe(true);
    expect(isEstimateOpen("VIEWED")).toBe(true);
    expect(isEstimateOpen("ACCEPTED")).toBe(false);
    expect(isEstimateOpen("EXPIRED")).toBe(false);
  });
});

describe("effectiveInvoiceStatus", () => {
  const invoice = (over: Partial<Parameters<typeof effectiveInvoiceStatus>[0]>) =>
    effectiveInvoiceStatus({
      status: "SENT",
      dueDate: daysFromNow(10),
      totalCents: 10000,
      amountPaidCents: 0,
      balanceCents: 10000,
      ...over,
    });

  it("reports PAID once the balance is cleared", () => {
    expect(invoice({ amountPaidCents: 10000, balanceCents: 0 })).toBe("PAID");
  });

  it("reports PAID on an overpayment, where the balance goes negative", () => {
    expect(invoice({ amountPaidCents: 12000, balanceCents: -2000 })).toBe("PAID");
  });

  it("reports OVERDUE once the due date passes with money outstanding", () => {
    expect(invoice({ dueDate: daysFromNow(-1) })).toBe("OVERDUE");
  });

  it("prefers PAID over OVERDUE when it was settled late", () => {
    expect(
      invoice({
        dueDate: daysFromNow(-30),
        amountPaidCents: 10000,
        balanceCents: 0,
      }),
    ).toBe("PAID");
  });

  it("reports PARTIALLY_PAID when some money has arrived and it is not yet due", () => {
    expect(invoice({ amountPaidCents: 3000, balanceCents: 7000 })).toBe(
      "PARTIALLY_PAID",
    );
  });

  it("prefers OVERDUE over PARTIALLY_PAID once the date passes", () => {
    // What matters operationally is that it is late, not that some arrived.
    expect(
      invoice({
        dueDate: daysFromNow(-1),
        amountPaidCents: 3000,
        balanceCents: 7000,
      }),
    ).toBe("OVERDUE");
  });

  it("leaves a draft alone even when it looks settled", () => {
    expect(
      invoice({ status: "DRAFT", amountPaidCents: 10000, balanceCents: 0 }),
    ).toBe("DRAFT");
  });

  it("leaves a cancelled invoice cancelled", () => {
    expect(
      invoice({
        status: "CANCELLED",
        dueDate: daysFromNow(-100),
        balanceCents: 10000,
      }),
    ).toBe("CANCELLED");
  });

  it("walks a stale PAID back when the payment is gone", () => {
    // Deleting a payment leaves status=PAID with a balance again; the derived
    // status has to correct that rather than keep claiming it is settled.
    expect(invoice({ status: "PAID", balanceCents: 10000 })).toBe("SENT");
    expect(
      invoice({ status: "PAID", dueDate: daysFromNow(-1), balanceCents: 10000 }),
    ).toBe("OVERDUE");
  });

  it("keeps VIEWED rather than dropping to SENT", () => {
    expect(invoice({ status: "VIEWED" })).toBe("VIEWED");
  });

  it("does not call a zero-total invoice paid", () => {
    // An empty draft that was sent has nothing owed but nothing paid either.
    expect(
      invoice({ totalCents: 0, amountPaidCents: 0, balanceCents: 0 }),
    ).toBe("SENT");
  });

  it("knows which derived statuses still owe money", () => {
    expect(invoiceIsOpen("OVERDUE")).toBe(true);
    expect(invoiceIsOpen("PARTIALLY_PAID")).toBe(true);
    expect(invoiceIsOpen("PAID")).toBe(false);
    expect(invoiceIsOpen("DRAFT")).toBe(false);
    expect(invoiceIsOpen("CANCELLED")).toBe(false);
  });
});

describe("ageingBucket", () => {
  it("treats anything not yet due as current", () => {
    expect(ageingBucket(null)).toBe("current");
    expect(ageingBucket(daysFromNow(5))).toBe("current");
    expect(ageingBucket(new Date())).toBe("current");
  });

  it("buckets by how far past due it is", () => {
    expect(ageingBucket(daysFromNow(-1))).toBe("1-30");
    expect(ageingBucket(daysFromNow(-30))).toBe("1-30");
    expect(ageingBucket(daysFromNow(-31))).toBe("31-60");
    expect(ageingBucket(daysFromNow(-60))).toBe("31-60");
    expect(ageingBucket(daysFromNow(-61))).toBe("60+");
    expect(ageingBucket(daysFromNow(-365))).toBe("60+");
  });
});

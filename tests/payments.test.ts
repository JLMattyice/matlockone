import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordRemotePayments } from "@/lib/payments/account";
import {
  availableProviders,
  isPaymentProvider,
  PAYMENT_PROVIDER_META,
  PAYMENT_PROVIDERS,
  partitionFields,
} from "@/lib/payments/catalog";
import { adapterFor } from "@/lib/payments/providers";
import { prisma } from "@/lib/db";

/**
 * Reconciliation is the part where a bug costs real money: a double-recorded
 * capture makes an invoice look overpaid and a client look owed a refund.
 * These run against the throwaway SQLite database, because the guarantee under
 * test is a database constraint, not a branch in TypeScript.
 */

let organizationId: string;
let clientId: string;
let invoiceId: string;

async function seedInvoice(totalCents: number) {
  const org = await prisma.organization.create({
    data: { slug: `reconcile-${randomUUID()}`, name: "Reconcile Test Co" },
  });

  const client = await prisma.client.create({
    data: { organizationId: org.id, displayName: "Test Client", type: "PERSON" },
  });

  const invoice = await prisma.invoice.create({
    data: {
      organizationId: org.id,
      clientId: client.id,
      number: `INV-${Date.now()}`,
      status: "SENT",
      totalCents,
      balanceCents: totalCents,
    },
  });

  return { organizationId: org.id, clientId: client.id, invoiceId: invoice.id };
}

const capture = (externalId: string, amountCents: number) => ({
  externalId,
  amountCents,
  paidAt: new Date("2026-08-30T12:00:00Z"),
});

beforeEach(async () => {
  ({ organizationId, clientId, invoiceId } = await seedInvoice(50_000));
});

afterEach(async () => {
  // Cascades through clients, invoices and payments, so each test starts from
  // an empty ledger rather than inheriting the last one's rows.
  await prisma.organization.deleteMany({ where: { id: organizationId } });
});

describe("recordRemotePayments", () => {
  it("records a settled payment and closes the invoice", async () => {
    const result = await recordRemotePayments({
      organizationId,
      invoiceId,
      clientId,
      provider: "PAYPAL",
      payments: [capture("PAY-1", 50_000)],
    });

    expect(result).toMatchObject({
      recorded: 1,
      amountCents: 50_000,
      settled: true,
      balanceCents: 0,
    });

    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
    });
    expect(invoice.status).toBe("PAID");
    expect(invoice.amountPaidCents).toBe(50_000);
    expect(invoice.paidAt).not.toBeNull();
  });

  it("does not record the same capture twice when polled again", async () => {
    const payments = [capture("PAY-1", 50_000)];

    await recordRemotePayments({
      organizationId,
      invoiceId,
      clientId,
      provider: "PAYPAL",
      payments,
    });

    // Polling repeats by design. The second pass must be inert.
    const second = await recordRemotePayments({
      organizationId,
      invoiceId,
      clientId,
      provider: "PAYPAL",
      payments,
    });

    expect(second.recorded).toBe(0);
    expect(second.amountCents).toBe(0);

    const rows = await prisma.payment.count({ where: { invoiceId } });
    expect(rows).toBe(1);

    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
    });
    // The thing that actually matters: no phantom overpayment.
    expect(invoice.amountPaidCents).toBe(50_000);
    expect(invoice.balanceCents).toBe(0);
  });

  it("records the new capture in a batch that repeats an old one", async () => {
    await recordRemotePayments({
      organizationId,
      invoiceId,
      clientId,
      provider: "PAYPAL",
      payments: [capture("PAY-1", 20_000)],
    });

    // A processor returns its whole history, so the next poll carries both.
    const second = await recordRemotePayments({
      organizationId,
      invoiceId,
      clientId,
      provider: "PAYPAL",
      payments: [capture("PAY-1", 20_000), capture("PAY-2", 30_000)],
    });

    expect(second.recorded).toBe(1);
    expect(second.amountCents).toBe(30_000);
    expect(second.settled).toBe(true);

    const rows = await prisma.payment.count({ where: { invoiceId } });
    expect(rows).toBe(2);
  });

  it("leaves a part-payment outstanding", async () => {
    const result = await recordRemotePayments({
      organizationId,
      invoiceId,
      clientId,
      provider: "STRIPE",
      payments: [capture("pi_1", 15_000)],
    });

    expect(result.settled).toBe(false);
    expect(result.balanceCents).toBe(35_000);

    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
    });
    expect(invoice.status).toBe("SENT");
    expect(invoice.paidAt).toBeNull();
  });

  it("keeps the same external id apart across two processors", async () => {
    // Stripe and PayPal each number from 1. The id is only unique per provider.
    await recordRemotePayments({
      organizationId,
      invoiceId,
      clientId,
      provider: "PAYPAL",
      payments: [capture("1", 10_000)],
    });
    const second = await recordRemotePayments({
      organizationId,
      invoiceId,
      clientId,
      provider: "STRIPE",
      payments: [capture("1", 10_000)],
    });

    expect(second.recorded).toBe(1);
    expect(await prisma.payment.count({ where: { invoiceId } })).toBe(2);
  });

  it("ignores a zero or negative amount rather than writing it", async () => {
    const result = await recordRemotePayments({
      organizationId,
      invoiceId,
      clientId,
      provider: "SQUARE",
      payments: [capture("z-1", 0), capture("z-2", -500)],
    });

    expect(result.recorded).toBe(0);
    expect(await prisma.payment.count({ where: { invoiceId } })).toBe(0);
  });

  it("marks the payments as online and attributed to no user", async () => {
    await recordRemotePayments({
      organizationId,
      invoiceId,
      clientId,
      provider: "PAYPAL",
      payments: [capture("PAY-9", 50_000)],
    });

    const payment = await prisma.payment.findFirstOrThrow({
      where: { invoiceId },
    });

    expect(payment.method).toBe("ONLINE");
    expect(payment.provider).toBe("PAYPAL");
    expect(payment.externalId).toBe("PAY-9");
    // Nobody in the office keyed this in, and pretending otherwise would put a
    // name against money they never touched.
    expect(payment.recordedById).toBeNull();
  });
});

describe("manual payment link", () => {
  const adapter = adapterFor("MANUAL")!;

  it("passes a valid link straight through", async () => {
    const result = await adapter.createLink(
      {
        invoiceNumber: "INV-1",
        description: "Ductwork cleaning",
        amountCents: 89_735,
        currency: "USD",
        clientName: "Desmond Achterberg",
        clientEmail: null,
        organizationName: "Matlock Field Services",
      },
      { paymentUrl: "https://paypal.me/matlockfield" },
      {},
    );

    expect(result).toEqual({
      ok: true,
      value: { url: "https://paypal.me/matlockfield", ref: null },
    });
  });

  it("rejects a link that is not https", async () => {
    const insecure = await adapter.verify(
      { paymentUrl: "http://paypal.me/matlockfield" },
      {},
    );
    expect(insecure.ok).toBe(false);

    const malformed = await adapter.verify({ paymentUrl: "paypal.me" }, {});
    expect(malformed.ok).toBe(false);
  });

  it("reports the host so the business can see where money goes", async () => {
    const result = await adapter.verify(
      { paymentUrl: "https://paypal.me/matlockfield" },
      {},
    );

    expect(result.ok && result.value.accountLabel).toBe("paypal.me");
  });

  it("never claims to know about payments it cannot see", async () => {
    // The catalog says reconciles: false, and the adapter agrees. If these two
    // ever disagreed the UI would offer a button that silently does nothing.
    expect(PAYMENT_PROVIDER_META.MANUAL.reconciles).toBe(false);
    expect(await adapter.listPayments(null, {}, {})).toEqual({
      ok: true,
      value: [],
    });
  });
});

describe("provider catalog", () => {
  it("only offers providers that have an adapter", () => {
    for (const id of availableProviders()) {
      expect(adapterFor(id), `${id} is offered but has no adapter`).not.toBeNull();
    }
  });

  it("does not offer a provider whose adapter is missing", () => {
    for (const id of PAYMENT_PROVIDERS) {
      if (PAYMENT_PROVIDER_META[id].available) continue;
      expect(adapterFor(id), `${id} is marked unavailable but has an adapter`).toBeNull();
    }
  });

  it("guards against a provider string an older build wrote", () => {
    expect(isPaymentProvider("PAYPAL")).toBe(true);
    expect(isPaymentProvider("SMTP")).toBe(false);
    expect(isPaymentProvider(undefined)).toBe(false);
  });

  it("treats every credential field as either secret or plain", () => {
    for (const id of PAYMENT_PROVIDERS) {
      const meta = PAYMENT_PROVIDER_META[id];
      const { secrets, plain } = partitionFields(meta);
      expect(secrets.length + plain.length).toBe(meta.fields.length);
    }
  });

  it("marks every provider that takes an API credential as secret", () => {
    // A token stored in the plain config column would sit unencrypted in the
    // database and be readable from the settings page.
    for (const id of PAYMENT_PROVIDERS) {
      for (const field of PAYMENT_PROVIDER_META[id].fields) {
        if (/secret|token|key/i.test(field.name)) {
          expect(field.secret, `${id}.${field.name} must be secret`).toBe(true);
        }
      }
    }
  });
});

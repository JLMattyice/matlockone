import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { recalculateInvoice } from "@/lib/invoice-balance";
import { allocateNumber } from "@/lib/numbering";

/**
 * These exercise the real database, because the thing under test is a
 * transaction: the payment rows are the ledger and the invoice caches a summary
 * of them, and the guarantee is that the two cannot drift. Mocking Prisma here
 * would test the mock.
 */

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! }),
});

let organizationId: string;
let clientId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { slug: `test-${randomUUID()}`, name: "Test Co" },
  });
  organizationId = org.id;

  const client = await prisma.client.create({
    data: { organizationId, displayName: "Test Client", type: "PERSON" },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: organizationId } });
  await prisma.$disconnect();
});

/** A sent invoice for a given total, with no payments against it yet. */
async function makeInvoice(totalCents: number, status = "SENT") {
  return prisma.invoice.create({
    data: {
      organizationId,
      clientId,
      number: `INV-${randomUUID().slice(0, 8)}`,
      status,
      totalCents,
      subtotalCents: totalCents,
      balanceCents: totalCents,
      amountPaidCents: 0,
      sentAt: status === "DRAFT" ? null : new Date(),
    },
  });
}

async function pay(invoiceId: string, amountCents: number) {
  return prisma.payment.create({
    data: { organizationId, clientId, invoiceId, amountCents, method: "CARD" },
  });
}

const recalc = (invoiceId: string) =>
  prisma.$transaction((tx) => recalculateInvoice(tx, invoiceId));

const read = (id: string) =>
  prisma.invoice.findUniqueOrThrow({ where: { id } });

describe("recalculateInvoice", () => {
  it("leaves an unpaid invoice owing its full total", async () => {
    const invoice = await makeInvoice(10000);
    await recalc(invoice.id);

    const after = await read(invoice.id);
    expect(after.amountPaidCents).toBe(0);
    expect(after.balanceCents).toBe(10000);
    expect(after.status).toBe("SENT");
    expect(after.paidAt).toBeNull();
  });

  it("records a partial payment without marking it paid", async () => {
    const invoice = await makeInvoice(10000);
    await pay(invoice.id, 3000);

    const result = await recalc(invoice.id);
    expect(result?.settled).toBe(false);
    expect(result?.balanceCents).toBe(7000);

    const after = await read(invoice.id);
    expect(after.amountPaidCents).toBe(3000);
    expect(after.balanceCents).toBe(7000);
    // The stored status stays SENT; PARTIALLY_PAID is derived at read time.
    expect(after.status).toBe("SENT");
    expect(after.paidAt).toBeNull();
  });

  it("sums several payments", async () => {
    const invoice = await makeInvoice(10000);
    await pay(invoice.id, 2500);
    await pay(invoice.id, 1500);
    await pay(invoice.id, 1000);

    await recalc(invoice.id);

    const after = await read(invoice.id);
    expect(after.amountPaidCents).toBe(5000);
    expect(after.balanceCents).toBe(5000);
  });

  it("marks it paid and stamps paidAt once the balance clears", async () => {
    const invoice = await makeInvoice(10000);
    await pay(invoice.id, 4000);
    await recalc(invoice.id);
    await pay(invoice.id, 6000);

    const result = await recalc(invoice.id);
    expect(result?.settled).toBe(true);

    const after = await read(invoice.id);
    expect(after.amountPaidCents).toBe(10000);
    expect(after.balanceCents).toBe(0);
    expect(after.status).toBe("PAID");
    expect(after.paidAt).toBeInstanceOf(Date);
  });

  it("treats an overpayment as paid, carrying a negative balance as credit", async () => {
    const invoice = await makeInvoice(10000);
    await pay(invoice.id, 12000);
    await recalc(invoice.id);

    const after = await read(invoice.id);
    expect(after.amountPaidCents).toBe(12000);
    expect(after.balanceCents).toBe(-2000);
    expect(after.status).toBe("PAID");
  });

  it("walks a paid invoice back when a payment is removed", async () => {
    const invoice = await makeInvoice(10000);
    const first = await pay(invoice.id, 4000);
    await pay(invoice.id, 6000);
    await recalc(invoice.id);
    expect((await read(invoice.id)).status).toBe("PAID");

    await prisma.payment.delete({ where: { id: first.id } });
    await recalc(invoice.id);

    const after = await read(invoice.id);
    expect(after.amountPaidCents).toBe(6000);
    expect(after.balanceCents).toBe(4000);
    expect(after.status).toBe("SENT");
    // paidAt must clear too, or the invoice claims a settlement date it no
    // longer has.
    expect(after.paidAt).toBeNull();
  });

  it("returns a reverted invoice to VIEWED when the client had seen it", async () => {
    const invoice = await makeInvoice(10000);
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: "VIEWED", viewedAt: new Date() },
    });

    const payment = await pay(invoice.id, 10000);
    await recalc(invoice.id);
    expect((await read(invoice.id)).status).toBe("PAID");

    await prisma.payment.delete({ where: { id: payment.id } });
    await recalc(invoice.id);

    expect((await read(invoice.id)).status).toBe("VIEWED");
  });

  it("never moves a draft, even when it is fully covered", async () => {
    const invoice = await makeInvoice(10000, "DRAFT");
    await pay(invoice.id, 10000);
    await recalc(invoice.id);

    const after = await read(invoice.id);
    // The figures still update; the status does not.
    expect(after.amountPaidCents).toBe(10000);
    expect(after.balanceCents).toBe(0);
    expect(after.status).toBe("DRAFT");
    expect(after.paidAt).toBeNull();
  });

  it("never resurrects a cancelled invoice", async () => {
    const invoice = await makeInvoice(10000, "CANCELLED");
    await pay(invoice.id, 10000);
    await recalc(invoice.id);

    expect((await read(invoice.id)).status).toBe("CANCELLED");
  });

  it("returns null for an invoice that no longer exists", async () => {
    const result = await recalc("does-not-exist");
    expect(result).toBeNull();
  });
});

describe("allocateNumber", () => {
  it("hands out consecutive numbers and advances the counter", async () => {
    const org = await prisma.organization.create({
      data: {
        slug: `numbering-${randomUUID()}`,
        name: "Numbering Co",
        invoicePrefix: "INV-",
        invoiceNextNumber: 500,
      },
    });

    const first = await prisma.$transaction((tx) =>
      allocateNumber(tx, org.id, "invoice"),
    );
    const second = await prisma.$transaction((tx) =>
      allocateNumber(tx, org.id, "invoice"),
    );

    expect(first).toBe("INV-500");
    expect(second).toBe("INV-501");

    const after = await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(after.invoiceNextNumber).toBe(502);

    await prisma.organization.delete({ where: { id: org.id } });
  });

  it("keeps each document type on its own counter", async () => {
    const org = await prisma.organization.create({
      data: {
        slug: `counters-${randomUUID()}`,
        name: "Counters Co",
        jobPrefix: "JOB-",
        jobNextNumber: 10,
        estimatePrefix: "EST-",
        estimateNextNumber: 20,
      },
    });

    const job = await prisma.$transaction((tx) =>
      allocateNumber(tx, org.id, "job"),
    );
    const estimate = await prisma.$transaction((tx) =>
      allocateNumber(tx, org.id, "estimate"),
    );

    expect(job).toBe("JOB-10");
    expect(estimate).toBe("EST-20");

    await prisma.organization.delete({ where: { id: org.id } });
  });

  it("gives the number back when the transaction rolls back", async () => {
    const org = await prisma.organization.create({
      data: {
        slug: `rollback-${randomUUID()}`,
        name: "Rollback Co",
        invoicePrefix: "INV-",
        invoiceNextNumber: 900,
      },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await allocateNumber(tx, org.id, "invoice");
        throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");

    // A burned number would leave a permanent gap in the invoice sequence,
    // which accountants and auditors do notice.
    const after = await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(after.invoiceNextNumber).toBe(900);

    await prisma.organization.delete({ where: { id: org.id } });
  });
});

/**
 * What deleting an invoice takes with it.
 *
 * The list screen offers a bulk delete and warns that "deleting also removes
 * any payments recorded against them". That sentence is a promise about the
 * database, so it is worth holding the database to it — if the cascade were
 * ever changed to SetNull, the warning would be a lie and the payments would
 * survive as orphans nobody can reach.
 */
describe("deleting an invoice", () => {
  it("takes its payments with it", async () => {
    const invoice = await makeInvoice(50_000);
    await pay(invoice.id, 20_000);
    await pay(invoice.id, 10_000);

    expect(await prisma.payment.count({ where: { invoiceId: invoice.id } })).toBe(2);

    await prisma.invoice.delete({ where: { id: invoice.id } });

    // The money recorded against it goes too. That is exactly the loss the
    // confirmation on the list screen is warning about.
    expect(await prisma.payment.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  it("leaves other invoices' payments alone", async () => {
    const doomed = await makeInvoice(10_000);
    const keeper = await makeInvoice(10_000);
    await pay(doomed.id, 5_000);
    await pay(keeper.id, 5_000);

    await prisma.invoice.delete({ where: { id: doomed.id } });

    // Selecting a few rows must not quietly reach past them.
    expect(await prisma.payment.count({ where: { invoiceId: keeper.id } })).toBe(1);
  });

  it("removes its line items too", async () => {
    const invoice = await makeInvoice(10_000);
    await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        name: "Call-out",
        quantity: 1,
        unitPriceCents: 10_000,
        totalCents: 10_000,
      },
    });

    await prisma.invoice.delete({ where: { id: invoice.id } });

    // Orphaned line items would accumulate invisibly in a file-backed database
    // that never gets vacuumed.
    expect(
      await prisma.invoiceLineItem.count({ where: { invoiceId: invoice.id } }),
    ).toBe(0);
  });
});

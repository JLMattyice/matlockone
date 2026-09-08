import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expenseSummary, listExpenses } from "@/app/(app)/expenses/queries";
import {
  cashFlowSeries,
  expenseTotals,
  spendByCategory,
  spendByVendor,
  type DateRange,
} from "@/app/(app)/reports/queries";
import { prisma } from "@/lib/db";

/**
 * The expense list is what an owner reads to decide whether the month made
 * money, so the two things worth pinning down are that the totals match what
 * was spent and that another business's spending can never reach them.
 *
 * Runs against the throwaway SQLite database, because the filtering under test
 * is a Prisma query rather than a branch in TypeScript.
 */

let organizationId: string;
let otherOrganizationId: string;
let jobId: string;
let payerId: string;

const daysAgo = (days: number) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date;
};

async function seedOrg(name: string) {
  const org = await prisma.organization.create({
    data: { slug: `expenses-${randomUUID()}`, name },
  });
  return org.id;
}

beforeEach(async () => {
  organizationId = await seedOrg("Expense Test Co");
  otherOrganizationId = await seedOrg("Someone Else Ltd");

  const client = await prisma.client.create({
    data: { organizationId, displayName: "Test Client", type: "PERSON" },
  });

  const job = await prisma.job.create({
    data: {
      organizationId,
      clientId: client.id,
      number: `JOB-${Date.now()}`,
      title: "Main panel replacement",
    },
  });
  jobId = job.id;

  const payer = await prisma.user.create({
    data: {
      organizationId,
      email: `tech-${randomUUID()}@example.com`,
      passwordHash: "x",
      name: "Field Tech",
      role: "EMPLOYEE",
    },
  });
  payerId = payer.id;

  await prisma.expense.createMany({
    data: [
      {
        organizationId,
        description: "Breakers and conduit",
        category: "MATERIALS",
        vendor: "Ferguson Supply",
        amountCents: 42_000,
        taxCents: 3_200,
        jobId,
        clientId: client.id,
        billable: true,
        spentAt: daysAgo(5),
      },
      {
        organizationId,
        description: "Meter socket",
        category: "MATERIALS",
        amountCents: 18_000,
        jobId,
        clientId: client.id,
        spentAt: daysAgo(40),
      },
      {
        organizationId,
        description: "Diesel",
        category: "FUEL",
        amountCents: 9_000,
        reimbursable: true,
        paidById: payerId,
        spentAt: daysAgo(3),
      },
      {
        organizationId,
        description: "Parking while on site",
        category: "TRAVEL",
        amountCents: 1_500,
        reimbursable: true,
        reimbursedAt: daysAgo(1),
        paidById: payerId,
        spentAt: daysAgo(2),
      },
      {
        organizationId: otherOrganizationId,
        description: "Not our money",
        category: "MATERIALS",
        amountCents: 999_000,
        spentAt: daysAgo(1),
      },
    ],
  });
});

afterEach(async () => {
  await prisma.organization.deleteMany({
    where: { id: { in: [organizationId, otherOrganizationId] } },
  });
});

describe("listExpenses", () => {
  it("totals only the caller's own organization", async () => {
    const list = await listExpenses({ organizationId, period: "all" });

    expect(list.total).toBe(4);
    expect(list.totalCents).toBe(70_500);
    expect(list.taxCents).toBe(3_200);
    expect(
      list.rows.some((row) => row.description === "Not our money"),
    ).toBe(false);
  });

  it("returns the newest spend first", async () => {
    const list = await listExpenses({ organizationId, period: "all" });

    expect(list.rows.map((row) => row.description)).toEqual([
      "Parking while on site",
      "Diesel",
      "Breakers and conduit",
      "Meter socket",
    ]);
  });

  it("drops rows outside the period", async () => {
    const list = await listExpenses({ organizationId, period: "30d" });

    expect(list.total).toBe(3);
    expect(list.totalCents).toBe(52_500);
  });

  it("filters by category, job and flag", async () => {
    await expect(
      listExpenses({ organizationId, period: "all", category: "MATERIALS" }),
    ).resolves.toMatchObject({ total: 2, totalCents: 60_000 });

    await expect(
      listExpenses({ organizationId, period: "all", jobId }),
    ).resolves.toMatchObject({ total: 2, totalCents: 60_000 });

    await expect(
      listExpenses({ organizationId, period: "all", flag: "billable" }),
    ).resolves.toMatchObject({ total: 1, totalCents: 42_000 });

    // "Owed back" is the unsettled subset of reimbursable, not all of it.
    await expect(
      listExpenses({ organizationId, period: "all", flag: "reimbursable" }),
    ).resolves.toMatchObject({ total: 2 });

    await expect(
      listExpenses({ organizationId, period: "all", flag: "unreimbursed" }),
    ).resolves.toMatchObject({ total: 1, totalCents: 9_000 });
  });

  it("searches description, vendor and the job it is booked to", async () => {
    await expect(
      listExpenses({ organizationId, period: "all", q: "Ferguson" }),
    ).resolves.toMatchObject({ total: 1 });

    await expect(
      listExpenses({ organizationId, period: "all", q: "panel" }),
    ).resolves.toMatchObject({ total: 2 });
  });
});

describe("expenseSummary", () => {
  it("ranks categories by spend", async () => {
    const summary = await expenseSummary({ organizationId, period: "all" });

    expect(summary.categories.map((row) => row.category)).toEqual([
      "MATERIALS",
      "FUEL",
      "TRAVEL",
    ]);
    expect(summary.categories[0]).toMatchObject({ count: 2, totalCents: 60_000 });
  });

  it("counts what is owed back regardless of the period filter", async () => {
    // The 30-day window excludes nothing reimbursable here, but the guarantee
    // is that money owed to a teammate does not disappear when the range moves.
    const narrow = await expenseSummary({ organizationId, period: "30d" });
    const wide = await expenseSummary({ organizationId, period: "all" });

    expect(narrow.unreimbursedCents).toBe(9_000);
    expect(narrow.unreimbursedCount).toBe(1);
    expect(wide.unreimbursedCents).toBe(narrow.unreimbursedCents);
  });
});

describe("receipts and notes", () => {
  /**
   * Both registries key an entity type to a column, and the actions behind
   * them once ended in an `else` that reached for invoices — so a newly
   * registered type wrote nothing and reported the record as missing. The
   * lookup is exhaustive now; this pins the schema half of that contract.
   */
  it("attaches a receipt and a note to an expense", async () => {
    const expense = await prisma.expense.create({
      data: {
        organizationId,
        description: "Trencher hire",
        category: "EQUIPMENT",
        amountCents: 125_000,
        spentAt: daysAgo(1),
      },
    });

    await prisma.attachment.create({
      data: {
        organizationId,
        expenseId: expense.id,
        fileName: "receipt.pdf",
        originalName: "receipt.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        storagePath: "receipts/receipt.pdf",
      },
    });

    await prisma.note.create({
      data: { organizationId, expenseId: expense.id, body: "Two-day hire." },
    });

    const loaded = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
      include: { attachments: true, notes: true },
    });

    expect(loaded.attachments).toHaveLength(1);
    expect(loaded.notes).toHaveLength(1);
  });

  it("takes the receipt and note rows with it when deleted", async () => {
    const expense = await prisma.expense.create({
      data: {
        organizationId,
        description: "Scaffold hire",
        category: "EQUIPMENT",
        amountCents: 60_000,
        spentAt: daysAgo(1),
        attachments: {
          create: {
            organizationId,
            fileName: "r.pdf",
            originalName: "r.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
            storagePath: "receipts/r.pdf",
          },
        },
        notes: { create: { organizationId, body: "Returned late." } },
      },
    });

    await prisma.expense.delete({ where: { id: expense.id } });

    await expect(
      prisma.attachment.count({ where: { expenseId: expense.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.note.count({ where: { expenseId: expense.id } }),
    ).resolves.toBe(0);
  });

  it("keeps the expense when the job it was booked to goes away", async () => {
    const expense = await prisma.expense.create({
      data: {
        organizationId,
        description: "Conduit",
        category: "MATERIALS",
        amountCents: 7_500,
        jobId,
        spentAt: daysAgo(1),
      },
    });

    await prisma.job.delete({ where: { id: jobId } });

    // A deleted job must not erase what it cost — the money still left.
    const loaded = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    expect(loaded.jobId).toBeNull();
    expect(loaded.amountCents).toBe(7_500);
  });
});

describe("reports", () => {
  const range = (): DateRange => ({
    from: daysAgo(30),
    to: daysAgo(-1),
    label: "Test range",
  });

  it("splits job costs from overhead by what was booked to a job", async () => {
    const totals = await expenseTotals(organizationId, range());

    // In range: breakers (42,000, on a job), diesel (9,000), parking (1,500).
    expect(totals.spentCents).toBe(52_500);
    expect(totals.expenseCount).toBe(3);
    expect(totals.jobCostCents).toBe(42_000);
    expect(totals.jobCostCount).toBe(1);
    expect(totals.overheadCents).toBe(10_500);
    expect(totals.taxCents).toBe(3_200);

    // The two halves always have to add back up to the whole.
    expect(totals.jobCostCents + totals.overheadCents).toBe(totals.spentCents);
  });

  it("counts what is owed back outside the reported range", async () => {
    // Diesel is unsettled but sits 3 days back; a range that excludes it must
    // still report the debt, because the money is still owed.
    const narrow: DateRange = {
      from: daysAgo(1),
      to: daysAgo(-1),
      label: "Yesterday on",
    };

    const totals = await expenseTotals(organizationId, narrow);

    expect(totals.spentCents).toBe(0);
    expect(totals.unreimbursedCents).toBe(9_000);
    expect(totals.unreimbursedCount).toBe(1);
  });

  it("keeps another organization's spending out of the totals", async () => {
    const totals = await expenseTotals(otherOrganizationId, range());
    expect(totals.spentCents).toBe(999_000);

    const ours = await expenseTotals(organizationId, range());
    expect(ours.spentCents).toBe(52_500);
  });

  it("ranks categories and vendors by spend", async () => {
    const [categories, vendors] = await Promise.all([
      spendByCategory(organizationId, range()),
      spendByVendor(organizationId, range()),
    ]);

    expect(categories.map((row) => row.label)).toEqual([
      "Materials",
      "Fuel",
      "Travel",
    ]);
    expect(categories[0]).toMatchObject({ count: 1, totalCents: 42_000 });

    // Only the materials row carries a vendor; the rest pool together.
    expect(vendors[0]).toMatchObject({
      vendor: "Ferguson Supply",
      totalCents: 42_000,
    });
    expect(vendors.map((row) => row.vendor)).toContain("Not recorded");
  });

  it("buckets money in and money out onto the same days", async () => {
    const client = await prisma.client.findFirstOrThrow({
      where: { organizationId },
    });
    const invoice = await prisma.invoice.create({
      data: {
        organizationId,
        clientId: client.id,
        number: `INV-${Date.now()}`,
        status: "PAID",
        totalCents: 100_000,
      },
    });
    await prisma.payment.create({
      data: {
        organizationId,
        invoiceId: invoice.id,
        amountCents: 100_000,
        receivedAt: daysAgo(3),
      },
    });

    const buckets = await cashFlowSeries(organizationId, range(), "day");

    // The payment and the diesel both landed 3 days ago, so a single bucket
    // has to carry both sides — that is the whole claim the chart makes.
    const day = buckets.find((b) => b.inCents > 0);
    expect(day).toBeDefined();
    expect(day!.inCents).toBe(100_000);
    expect(day!.outCents).toBe(9_000);

    expect(buckets.reduce((sum, b) => sum + b.outCents, 0)).toBe(52_500);
  });
});

import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deposits and progress invoices.
 *
 * The promise worth pinning is arithmetic: however a job is billed — a
 * deposit, shares as the work goes, then the final invoice — the invoices
 * together come to the estimate's total to the cent, and the final one's tax
 * is the whole job's. Around it: nothing is billed twice, nothing past what
 * is left, and a deposit asked for is billed the moment the customer signs.
 */

const session = vi.hoisted(() => ({
  user: null as unknown as Record<string, unknown>,
  org: null as unknown as Record<string, unknown>,
}));

vi.mock("@/lib/auth", () => ({
  requireContext: async () => session,
  requirePermission: async () => session,
  getContext: async () => session,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}`, "user-agent": "test" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { billEstimate } from "@/app/(app)/estimates/actions";
import {
  deleteInvoice,
  deleteInvoices,
  setInvoiceCancelled,
  updateInvoice,
} from "@/app/(app)/invoices/actions";
import { respondToEstimate } from "@/app/share/estimate/[token]/actions";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import { effectiveInvoiceStatus } from "@/lib/documents";
import { estimateVersion } from "@/lib/estimate-signature";
import { computeTotals, depositCentsFor } from "@/lib/money";
import { estimateBilling, priorBilling } from "@/lib/progress-billing";

// ------------------------------------------------------------ arithmetic ---


describe("the arithmetic", () => {
  it("works a deposit out as a percent or an amount, never past the total", () => {
    expect(depositCentsFor(108_000, "PERCENT", 5_000)).toBe(54_000);
    expect(depositCentsFor(108_000, "FIXED", 25_000)).toBe(25_000);
    expect(depositCentsFor(108_000, "FIXED", 500_000)).toBe(108_000);
    expect(depositCentsFor(108_000, "NONE", 5_000)).toBe(0);
  });

  it("takes a credit off after tax, and never past the document's total", () => {
    const line = { quantity: 1, unitPriceCents: 100_000, taxable: true };
    expect(computeTotals({ lineItems: [line], discountType: "NONE", discountValue: 0, taxRateBp: 800, creditCents: 54_000 })).toMatchObject({
      subtotalCents: 100_000,
      taxCents: 8_000,
      creditCents: 54_000,
      totalCents: 54_000,
    });
    expect(
      computeTotals({ lineItems: [line], discountType: "NONE", discountValue: 0, taxRateBp: 0, creditCents: 999_999 }),
    ).toMatchObject({ creditCents: 100_000, totalCents: 0 });
  });
});

// ---------------------------------------------------------------- billing ---

const orgs: string[] = [];
let organizationId: string;
let estimateId: string;
let token: string;

/**
 * $1,000 of taxable work at 8% — $1,080 in all — asking 50% down. A second,
 * non-taxable line keeps the tax from being a round share of the total.
 */
async function setUp(status = "ACCEPTED") {
  const org = await prisma.organization.create({
    data: { slug: `billing-${randomUUID()}`, name: "Billing Test Co", billingExempt: true },
  });
  orgs.push(org.id);
  organizationId = org.id;
  const owner = await prisma.user.create({
    data: { organizationId, email: `${randomUUID()}@test.local`, name: "Owner", passwordHash: "x", role: "OWNER" },
  });
  session.org = org as unknown as Record<string, unknown>;
  session.user = owner as unknown as Record<string, unknown>;

  const client = await prisma.client.create({ data: { organizationId, displayName: "Jane Doe", type: "PERSON" } });
  const estimate = await prisma.estimate.create({
    data: {
      organizationId,
      clientId: client.id,
      number: "EST-2001",
      status,
      sentAt: new Date(),
      subtotalCents: 100_000,
      taxRateBp: 800,
      taxCents: 8_000,
      totalCents: 108_000,
      depositType: "PERCENT",
      depositValue: 5_000,
      depositCents: 54_000,
      lineItems: {
        create: [
          { name: "Deck build", quantity: 1, unitPriceCents: 90_000, totalCents: 90_000, taxable: true, sortOrder: 0 },
          { name: "Permit", quantity: 1, unitPriceCents: 10_000, totalCents: 10_000, taxable: true, sortOrder: 1 },
        ],
      },
    },
  });
  estimateId = estimate.id;
  token = estimate.publicToken;
}

beforeEach(async () => {
  await setUp();
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

/** Bills a stage; returns the invoice it opened, or the refusal. */
async function bill(fields: Record<string, string>) {
  const form = new FormData();
  form.set("id", estimateId);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  try {
    const refused = await billEstimate(IDLE, form);
    return { refused };
  } catch (error) {
    const match = /NEXT_REDIRECT \/invoices\/(\S+)/.exec(String((error as Error).message));
    if (!match) throw error;
    return { invoice: await prisma.invoice.findUniqueOrThrow({ where: { id: match[1] }, include: { lineItems: true } }) };
  }
}

describe("billing an accepted estimate in parts", () => {
  it("adds up to the estimate's total to the cent, with the whole job's tax on the final invoice", async () => {
    const deposit = (await bill({ stage: "DEPOSIT" })).invoice!;
    expect(deposit).toMatchObject({
      billingStage: "DEPOSIT",
      status: "DRAFT",
      estimateId,
      totalCents: 54_000,
      taxCents: 0,
      balanceCents: 54_000,
    });
    expect(deposit.lineItems).toMatchObject([{ name: "Deposit — 50% of Estimate EST-2001", taxable: false }]);

    const progress = (await bill({ stage: "PROGRESS", mode: "PERCENT", value: "25" })).invoice!;
    expect(progress).toMatchObject({ billingStage: "PROGRESS", totalCents: 27_000 });

    const final = (await bill({ stage: "FINAL" })).invoice!;
    expect(final).toMatchObject({
      billingStage: "FINAL",
      subtotalCents: 100_000,
      taxCents: 8_000,
      creditCents: 81_000,
      totalCents: 27_000,
      creditLabel: `Previously billed (${deposit.number}, ${progress.number})`,
    });
    expect(final.lineItems.map((line) => line.name).sort()).toEqual(["Deck build", "Permit"]);
    expect(deposit.totalCents + progress.totalCents + final.totalCents).toBe(108_000);

    expect(await estimateBilling(estimateId)).toMatchObject({ billedCents: 108_000, remainingCents: 0 });
  });

  it("will not bill the deposit twice, past what is left, after the final invoice, or before acceptance", async () => {
    await bill({ stage: "DEPOSIT" });
    expect((await bill({ stage: "DEPOSIT" })).refused).toEqual({
      ok: false,
      error: "A deposit has already been billed for this.",
    });
    expect((await bill({ stage: "PROGRESS", mode: "AMOUNT", value: "600" })).refused).toEqual({
      ok: false,
      error: "Only $540.00 is left to bill on this.",
    });
    expect((await bill({ stage: "PROGRESS", mode: "PERCENT", value: "0" })).refused).toMatchObject({ ok: false });

    await bill({ stage: "FINAL" });
    expect((await bill({ stage: "PROGRESS", mode: "AMOUNT", value: "1" })).refused).toEqual({
      ok: false,
      error: "The final invoice for this has already been made.",
    });

    await setUp("SENT");
    expect((await bill({ stage: "DEPOSIT" })).refused).toEqual({
      ok: false,
      error: "Only an accepted estimate can be billed in parts.",
    });
  });

  it("leaves a cancelled stage out of what has been billed", async () => {
    const deposit = (await bill({ stage: "DEPOSIT" })).invoice!;
    await prisma.invoice.update({ where: { id: deposit.id }, data: { status: "CANCELLED" } });

    expect(await priorBilling(prisma, estimateId)).toMatchObject({ cents: 0, label: null });
    const final = (await bill({ stage: "FINAL" })).invoice!;
    expect(final).toMatchObject({ creditCents: 0, totalCents: 108_000 });
  });
  it("keeps the stages the final invoice counts as they are, until the final invoice is cancelled", async () => {
    const deposit = (await bill({ stage: "DEPOSIT" })).invoice!;
    const final = (await bill({ stage: "FINAL" })).invoice!;
    const form = (fields: Record<string, string>) => {
      const data = new FormData();
      for (const [key, value] of Object.entries(fields)) data.set(key, value);
      return data;
    };

    await setInvoiceCancelled(form({ id: deposit.id }));
    await deleteInvoices(form({ ids: deposit.id }));
    await deleteInvoice(form({ id: deposit.id })).catch(() => {});
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: deposit.id } })).toMatchObject({ status: "DRAFT" });
    expect(await updateInvoice(IDLE, form({ id: deposit.id }))).toEqual({
      ok: false,
      error: `Final invoice ${final.number} already takes this one off. Cancel the final invoice first, then change this.`,
    });

    await setInvoiceCancelled(form({ id: final.id }));
    await setInvoiceCancelled(form({ id: deposit.id }));
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: deposit.id } })).toMatchObject({ status: "CANCELLED" });
  });
});

/** What the customer's page hands back with a signature: the version it showed. */
async function versionOf(publicToken: string) {
  const shown = await prisma.estimate.findUniqueOrThrow({
    where: { publicToken },
    include: { lineItems: { orderBy: { sortOrder: "asc" } }, organization: { select: { estimateFooter: true } } },
  });
  return estimateVersion(shown, shown.organization.estimateFooter);
}

describe("a deposit asked for on the estimate", () => {
  it("is billed the moment the customer signs, ready for them to pay", async () => {
    await setUp("SENT");
    expect(await respondToEstimate(token, "ACCEPTED", {
      signature: { name: "Jane Doe", agreed: true },
      version: await versionOf(token),
    })).toEqual({
      ok: true,
    });

    const billing = (await estimateBilling(estimateId))!;
    expect(billing.deposit).toMatchObject({ status: "SENT", totalCents: 54_000, balanceCents: 54_000 });

    // Due today — not overdue the second it is made.
    const deposit = await prisma.invoice.findUniqueOrThrow({ where: { id: billing.deposit!.id } });
    expect(effectiveInvoiceStatus(deposit)).toBe("SENT");

    const [notice] = await prisma.notification.findMany({ where: { organizationId } });
    expect(notice.body).toBe(`Signed by Jane Doe. Their deposit invoice ${billing.deposit!.number} ($540.00) is ready for them to pay.`);

    // What they signed includes the deposit.
    const signed = await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    expect(JSON.parse(signed.signedSnapshot!).depositCents).toBe(54_000);
  });

  it("bills nothing when the estimate asks for no deposit", async () => {
    await setUp("SENT");
    await prisma.estimate.update({
      where: { id: estimateId },
      data: { depositType: "NONE", depositValue: 0, depositCents: 0 },
    });
    await respondToEstimate(token, "ACCEPTED", {
      signature: { name: "Jane Doe", agreed: true },
      version: await versionOf(token),
    });
    expect(await prisma.invoice.count({ where: { estimateId } })).toBe(0);
  });
});

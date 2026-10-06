import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Correcting and deleting a payment after it was recorded.
 *
 * The promise worth pinning is that the invoice follows: its balance and
 * status are worked out again from what is left, so a fixed amount can settle
 * an invoice or put it back to owing. Around it: a payment a processor
 * reported keeps the processor's figures, a save that changes nothing writes
 * nothing, each change is on the record, and "back" never leaves the site.
 */

const session = vi.hoisted(() => ({
  user: null as unknown as Record<string, unknown>,
  org: null as unknown as Record<string, unknown>,
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
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
  headers: async () => new Headers({ "user-agent": "test" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { deletePayment, updatePayment } from "@/app/(app)/invoices/actions";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";

const orgs: string[] = [];
let organizationId: string;
let clientId: string;
let invoiceId: string;

/** A $100 invoice, sent, with nothing paid yet. */
beforeEach(async () => {
  const org = await prisma.organization.create({
    data: {
      slug: `payment-edits-${randomUUID()}`,
      name: "Payment Edits Co",
      billingExempt: true,
      timeZone: "America/New_York",
    },
  });
  orgs.push(org.id);
  organizationId = org.id;
  const owner = await prisma.user.create({
    data: { organizationId, email: `${randomUUID()}@test.local`, name: "Owner", passwordHash: "x", role: "OWNER" },
  });
  session.org = org as unknown as Record<string, unknown>;
  session.user = owner as unknown as Record<string, unknown>;

  const client = await prisma.client.create({ data: { organizationId, displayName: "Jane Doe", type: "PERSON" } });
  clientId = client.id;
  const invoice = await prisma.invoice.create({
    data: {
      organizationId,
      clientId,
      number: "INV-1042",
      status: "SENT",
      sentAt: new Date(),
      totalCents: 10_000,
      balanceCents: 10_000,
    },
  });
  invoiceId = invoice.id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

/** A payment as recordPayment leaves it: noon on the day, then the invoice worked out. */
async function paid(amountCents: number, extra: Record<string, unknown> = {}) {
  const payment = await prisma.payment.create({
    data: {
      organizationId,
      invoiceId,
      clientId,
      amountCents,
      method: "CHECK",
      receivedAt: new Date("2026-10-01T12:00:00Z"),
      reference: "1042",
      ...extra,
    },
  });
  const { recalculateInvoice } = await import("@/lib/invoice-balance");
  await prisma.$transaction((tx) => recalculateInvoice(tx, invoiceId));
  return payment;
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const back = () => `/clients/${clientId}?view=payments`;
const invoice = () => prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

describe("editing a payment", () => {
  it("settles the invoice when the corrected amount covers it, and says what changed", async () => {
    const payment = await paid(9_000);
    expect(await invoice()).toMatchObject({ status: "SENT", balanceCents: 1_000 });

    await expect(
      updatePayment(
        IDLE,
        form({ id: payment.id, amount: "100.00", method: "CHECK", receivedAt: "2026-10-01", reference: "1042", back: back() }),
      ),
    ).rejects.toThrow(`NEXT_REDIRECT ${back()}`);

    expect(await invoice()).toMatchObject({ status: "PAID", amountPaidCents: 10_000, balanceCents: 0 });
    const saved = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(saved.amountCents).toBe(10_000);
    expect(saved.editedAt).toBeInstanceOf(Date);

    const logged = await prisma.auditLog.findFirstOrThrow({ where: { organizationId, action: "payment.changed" } });
    expect(logged).toMatchObject({ entityType: "INVOICE", entityId: invoiceId });
    expect(logged.summary).toBe("Payment on invoice INV-1042 corrected — amount $90.00 → $100.00");
  });

  it("puts a paid invoice back to owing when the amount comes down", async () => {
    const payment = await paid(10_000);
    expect((await invoice()).status).toBe("PAID");

    await expect(
      updatePayment(IDLE, form({ id: payment.id, amount: "60", method: "CASH", receivedAt: "2026-10-01", reference: "1042" })),
    ).rejects.toThrow(`NEXT_REDIRECT /invoices/${invoiceId}`);

    expect(await invoice()).toMatchObject({ status: "SENT", balanceCents: 4_000, paidAt: null });
    const logged = await prisma.auditLog.findFirstOrThrow({ where: { organizationId, action: "payment.changed" } });
    expect(logged.summary).toBe(
      "Payment on invoice INV-1042 corrected — amount $100.00 → $60.00, method Check → Cash",
    );
  });

  it("keeps the moment it was saved at when the day shown is not changed, and moves it when it is", async () => {
    const payment = await paid(5_000, { receivedAt: new Date("2026-10-01T03:30:00Z") }); // Sep 30, 11:30pm in New York

    await expect(
      updatePayment(IDLE, form({ id: payment.id, amount: "50", method: "CHECK", receivedAt: "2026-09-30", reference: "1043" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    let saved = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(saved.receivedAt.toISOString()).toBe("2026-10-01T03:30:00.000Z");
    expect(saved.reference).toBe("1043");

    await expect(
      updatePayment(IDLE, form({ id: payment.id, amount: "50", method: "CHECK", receivedAt: "2026-10-03", reference: "1043" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    saved = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(saved.receivedAt.getTime()).not.toBe(new Date("2026-10-01T03:30:00Z").getTime());
    expect(saved.receivedAt.toISOString().slice(0, 10)).toBe("2026-10-03");
  });

  it("writes nothing when nothing changed", async () => {
    const payment = await paid(5_000);

    await expect(
      updatePayment(IDLE, form({ id: payment.id, amount: "50.00", method: "CHECK", receivedAt: "2026-10-01", reference: "1042" })),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).editedAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { organizationId, action: "payment.changed" } })).toBe(0);
  });

  it("refuses an amount that is not above zero, and changes nothing", async () => {
    const payment = await paid(5_000);

    for (const amount of ["0", "-5", "abc", ""]) {
      expect(
        await updatePayment(IDLE, form({ id: payment.id, amount, method: "CHECK", receivedAt: "2026-10-01" })),
      ).toEqual({ ok: false, fieldErrors: { amount: "Enter an amount above zero." } });
    }
    expect(await updatePayment(IDLE, form({ id: payment.id, amount: "50", method: "CHECK", receivedAt: "" }))).toEqual({
      ok: false,
      fieldErrors: { receivedAt: "Pick a date." },
    });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).amountCents).toBe(5_000);
  });

  it("keeps a processor's amount, method and date, and saves the reference and notes", async () => {
    const payment = await paid(5_000, {
      method: "ONLINE",
      provider: "PAYPAL",
      externalId: "CAPTURE-1",
      receivedAt: new Date("2026-10-01T15:04:05Z"),
    });

    await expect(
      updatePayment(
        IDLE,
        form({ id: payment.id, amount: "999", method: "CASH", receivedAt: "2026-01-01", reference: "PP-1", notes: "Deposit for the deck" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({
      amountCents: 5_000,
      method: "ONLINE",
      receivedAt: new Date("2026-10-01T15:04:05Z"),
      reference: "PP-1",
      notes: "Deposit for the deck",
    });
    expect((await invoice()).balanceCents).toBe(5_000);
  });

  it("cannot reach another business's payment", async () => {
    const payment = await paid(5_000);
    const other = await prisma.organization.create({
      data: { slug: `payment-edits-${randomUUID()}`, name: "Someone Else", billingExempt: true },
    });
    orgs.push(other.id);
    session.org = other as unknown as Record<string, unknown>;

    expect(
      await updatePayment(IDLE, form({ id: payment.id, amount: "1", method: "CASH", receivedAt: "2026-10-01" })),
    ).toEqual({ ok: false, error: "That payment no longer exists." });
    await deletePayment(form({ id: payment.id }));

    expect(await prisma.payment.findUnique({ where: { id: payment.id } })).not.toBeNull();
  });

  it("never sends anybody off the site afterwards", async () => {
    const payment = await paid(5_000);

    await expect(
      updatePayment(
        IDLE,
        form({ id: payment.id, amount: "40", method: "CHECK", receivedAt: "2026-10-01", back: "//evil.example/steal" }),
      ),
    ).rejects.toThrow(`NEXT_REDIRECT /invoices/${invoiceId}`);
  });
});

describe("deleting a payment", () => {
  it("puts its amount back on the invoice, notes it, and goes back where it came from", async () => {
    const first = await paid(6_000);
    await paid(4_000);
    expect((await invoice()).status).toBe("PAID");

    await expect(deletePayment(form({ id: first.id, back: back() }))).rejects.toThrow(`NEXT_REDIRECT ${back()}`);

    expect(await prisma.payment.findUnique({ where: { id: first.id } })).toBeNull();
    expect(await invoice()).toMatchObject({ status: "SENT", balanceCents: 6_000 });
    const logged = await prisma.auditLog.findFirstOrThrow({ where: { organizationId, action: "payment.removed" } });
    expect(logged.summary).toBe("$60.00 payment on invoice INV-1042 deleted");
  });

  it("stays put when deleted from a list with no page to go back to", async () => {
    const payment = await paid(6_000);
    await expect(deletePayment(form({ id: payment.id }))).resolves.toBeUndefined();
    expect(await prisma.payment.findUnique({ where: { id: payment.id } })).toBeNull();
  });

  it("goes back without complaint when it was already gone", async () => {
    await expect(deletePayment(form({ id: "no-such-payment", back: back() }))).rejects.toThrow(
      `NEXT_REDIRECT ${back()}`,
    );
  });
});

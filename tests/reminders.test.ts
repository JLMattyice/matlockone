import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakePaypal, type FakePaypal } from "./support/paypal-server";

/**
 * Reminders, and pay links that ask for the wrong amount.
 *
 * Two promises. A client who has paid is not chased: before a reminder goes
 * out, the processor is asked, and an invoice it cannot answer for is held
 * back rather than chased on a guess. And no client is offered a pay link
 * for an amount they no longer owe: a processor's link is fixed at the
 * balance it was made for, so after a part-payment or an edit it is left out
 * of the reminder, the invoice email, the PDF and the client's page.
 *
 * Driven against the PayPal stand-in and the test database. Reminders land in
 * the outbox whether or not a mailbox is connected, which is where they are
 * read back from.
 */

const session = vi.hoisted(() => ({
  org: null as unknown,
  user: null as unknown,
}));

vi.mock("@/lib/auth", () => ({
  requireContext: async () => session,
  requirePermission: async () => session,
  getContext: async () => session,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { sendInvoiceReminders } from "@/app/(app)/invoices/reminders";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import { recalculateInvoice } from "@/lib/invoice-balance";
import { attachPaymentLink } from "@/lib/payments/link";
import { offeredPayLink, payLinkIsStale, type LinkedInvoice } from "@/lib/payments/link-amount";
import { forgetPaypalToken } from "@/lib/payments/paypal";
import { seal } from "@/lib/secret-box";
import type { Organization, Prisma } from "@/generated/prisma/client";

const KEY = "r".repeat(32);
let savedKey: string | undefined;

let paypal: FakePaypal;
let org: Organization;
let ownerId: string;
let clientId: string;
const made: string[] = [];

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000);

async function connectPaypal(organizationId: string) {
  const sealed = seal(JSON.stringify({ clientId: "test-client-id", clientSecret: "test-client-secret" }));
  await prisma.integration.create({
    data: {
      organizationId,
      kind: "PAYMENT",
      provider: "PAYPAL",
      isActive: true,
      config: JSON.stringify({ environment: "sandbox" }),
      secretCipher: sealed.cipherText,
      secretNonce: sealed.nonce,
      secretTag: sealed.tag,
    },
  });
}

/** A $500 invoice, overdue by a week. */
function overdueInvoice() {
  return prisma.invoice.create({
    data: {
      organizationId: org.id,
      clientId,
      number: `INV-${randomUUID().slice(0, 8)}`,
      title: "Patio install",
      status: "SENT",
      issueDate: daysFromNow(-30),
      dueDate: daysFromNow(-7),
      subtotalCents: 50_000,
      totalCents: 50_000,
      balanceCents: 50_000,
      createdById: ownerId,
    },
    include: { client: true },
  });
}

/** The same, with a PayPal pay link made for the whole $500. */
async function linkedInvoice() {
  const invoice = await overdueInvoice();
  const linked = await attachPaymentLink(org, invoice);
  if (!linked.ok) throw new Error(`No pay link: ${JSON.stringify(linked)}`);
  return prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, include: { client: true } });
}

/** A payment entered by hand — cash at the door. */
async function recordCash(invoiceId: string, amountCents: number) {
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.payment.create({
      data: {
        organizationId: org.id,
        invoiceId,
        clientId,
        amountCents,
        method: "CASH",
        receivedAt: new Date(),
        recordedById: ownerId,
      },
    });
    await recalculateInvoice(tx, invoiceId);
  });
}

const remindersFor = (invoiceId: string) =>
  prisma.outboxMessage.findMany({ where: { relatedType: "invoice", relatedId: invoiceId } });

beforeAll(() => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY;
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
});

beforeEach(async () => {
  paypal = await startFakePaypal();
  process.env.PAYPAL_API_BASE = paypal.baseUrl;
  forgetPaypalToken();

  org = await prisma.organization.create({
    data: { slug: `remind-${randomUUID()}`, name: "Stoneworks Co", billingExempt: true },
  });
  made.push(org.id);
  const owner = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `owner-${randomUUID()}@example.test`,
      name: "Morgan Hale",
      passwordHash: "x",
      role: "OWNER",
    },
  });
  ownerId = owner.id;
  session.org = org;
  session.user = owner;

  const client = await prisma.client.create({
    data: { organizationId: org.id, displayName: "Priya Raman", type: "PERSON", email: "priya@example.test" },
  });
  clientId = client.id;

  await connectPaypal(org.id);
});

afterEach(async () => {
  // Shared test database: no PayPal connection may outlive the stand-in.
  await prisma.integration.deleteMany({ where: { organizationId: { in: made } } });
  delete process.env.PAYPAL_API_BASE;
  forgetPaypalToken();
  await paypal.close();
});

// --------------------------------------------------------------- the rule ---

describe("whether a pay link still asks for what is owed", () => {
  const invoice = (over: Partial<LinkedInvoice> = {}): LinkedInvoice => ({
    paymentUrl: "https://www.paypal.com/invoice/p/#INV2-1",
    paymentRef: "INV2-1",
    paymentLinkCents: 50_000,
    balanceCents: 50_000,
    amountPaidCents: 0,
    ...over,
  });

  it("offers a link made for the balance", () => {
    expect(payLinkIsStale(invoice())).toBe(false);
    expect(offeredPayLink(invoice())).toBe("https://www.paypal.com/invoice/p/#INV2-1");
  });

  it("withholds one made for a different amount", () => {
    const partPaid = invoice({ balanceCents: 30_000, amountPaidCents: 20_000 });
    expect(payLinkIsStale(partPaid)).toBe(true);
    expect(offeredPayLink(partPaid)).toBeNull();

    // An edit after the link was made moves the balance with nothing paid.
    expect(payLinkIsStale(invoice({ balanceCents: 55_000 }))).toBe(true);
  });

  it("never second-guesses a link with no fixed amount", () => {
    // A pasted link, or Clover's page made at the moment it is clicked.
    const live = invoice({ paymentRef: null, paymentLinkCents: null, balanceCents: 30_000, amountPaidCents: 20_000 });
    expect(payLinkIsStale(live)).toBe(false);
    expect(offeredPayLink(live)).not.toBeNull();
  });

  it("is cautious about a link made before its amount was recorded", () => {
    expect(payLinkIsStale(invoice({ paymentLinkCents: null }))).toBe(false);
    expect(payLinkIsStale(invoice({ paymentLinkCents: null, balanceCents: 30_000, amountPaidCents: 20_000 }))).toBe(true);
  });

  it("offers nothing once nothing is owed", () => {
    expect(offeredPayLink(invoice({ balanceCents: 0, amountPaidCents: 50_000 }))).toBeNull();
  });
});

describe("attaching a pay link", () => {
  it("records what the link asks for", async () => {
    const invoice = await linkedInvoice();
    expect(invoice.paymentLinkCents).toBe(50_000);
  });

  it("refuses to reuse a link the balance has moved away from, and makes no second one", async () => {
    const invoice = await linkedInvoice();
    await recordCash(invoice.id, 20_000);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, include: { client: true } });

    const linked = await attachPaymentLink(org, after);

    expect(linked).toEqual({ ok: false, reason: "stale" });
    expect(paypal.invoices.size).toBe(1);
  });
});

// -------------------------------------------------------------- reminders ---

describe("Send reminders", () => {
  it("chases an unpaid invoice, with its pay link", async () => {
    const invoice = await linkedInvoice();

    const state = await sendInvoiceReminders(IDLE, new FormData());

    expect(state).toMatchObject({ ok: true, message: "1 reminder sent." });
    const [reminder] = await remindersFor(invoice.id);
    expect(reminder.subject).toBe(`Overdue reminder — invoice ${invoice.number}`);
    expect(reminder.body).toContain(`Pay online: ${invoice.paymentUrl}`);
    expect(reminder.body).toContain("for $500.00 was due");
  });

  it("does not chase a client who has paid online since", async () => {
    const invoice = await linkedInvoice();
    paypal.pay(invoice.paymentRef!, "500.00", "PAY-SINCE");

    const state = await sendInvoiceReminders(IDLE, new FormData());

    expect(state.message).toBe(`Not chased, because it has been paid: ${invoice.number}.`);
    expect(await remindersFor(invoice.id)).toHaveLength(0);
    // Found by asking, and written in on the way.
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("PAID");
  });

  it("holds a reminder back when the processor cannot say", async () => {
    const invoice = await linkedInvoice();
    await paypal.close();
    paypal = await startFakePaypal({ failWith: { status: 503, path: "/v2/invoicing/invoices/" } });
    process.env.PAYPAL_API_BASE = paypal.baseUrl;
    forgetPaypalToken();

    const state = await sendInvoiceReminders(IDLE, new FormData());

    expect(state.message).toMatch(/^Held back, because PayPal couldn’t say/);
    expect(state.message).toContain(invoice.number);
    expect(await remindersFor(invoice.id)).toHaveLength(0);
  });

  it("states what is left after a part-payment, and leaves out a link for the old amount", async () => {
    const invoice = await linkedInvoice();
    await recordCash(invoice.id, 20_000);

    const state = await sendInvoiceReminders(IDLE, new FormData());

    expect(state.message).toBe(
      `1 reminder sent. Sent without a Pay now link, because the link asks for an old amount — replace it on the invoice: ${invoice.number}.`,
    );
    const [reminder] = await remindersFor(invoice.id);
    expect(reminder.body).toContain("$300.00 of it is still outstanding");
    expect(reminder.body).not.toContain("Pay online");
    expect(reminder.body).not.toContain(invoice.paymentUrl!);
  });

  it("still chases when there is nothing to ask a processor about", async () => {
    await prisma.integration.deleteMany({ where: { organizationId: org.id } });
    const invoice = await overdueInvoice();

    const state = await sendInvoiceReminders(IDLE, new FormData());

    expect(state.message).toBe("1 reminder sent.");
    const [reminder] = await remindersFor(invoice.id);
    expect(reminder.body).not.toContain("Pay online");
  });

  it("chases nobody twice in a day", async () => {
    await linkedInvoice();
    await sendInvoiceReminders(IDLE, new FormData());

    const again = await sendInvoiceReminders(IDLE, new FormData());

    expect(again.message).toBe("1 already chased today.");
  });
});

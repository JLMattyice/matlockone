import { randomUUID } from "node:crypto";

import { addDays, format } from "date-fns";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auto-pay for repeating invoices, on PayPal.
 *
 * Driven end to end over real HTTP against the fake PayPal, with a real
 * business, customer and series in the test database: the business offers
 * it, the customer's click makes a subscription, PayPal approving and
 * charging is simulated at the fake, and the morning check is what records
 * it. What is pinned is the money: each charge lands once, on its own
 * period's invoice; nobody is charged twice; and nothing keeps charging
 * after the business has said stop.
 *
 * It cannot prove PayPal's live API matches the fake — only a sandbox or a
 * real account can.
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

import { startFakePaypal, type FakePaypal } from "./support/paypal-server";
import { saveInvoiceRepeat, stopInvoiceRepeat } from "@/app/(app)/invoices/repeat";
import { GET as start } from "@/app/share/autopay/[token]/start/route";
import { IDLE } from "@/lib/action-state";
import {
  autopayInvite,
  autopayStatus,
  offerAutopay,
  paymentsUntil,
  syncAutopay,
  turnOffAutopay,
} from "@/lib/autopay";
import { prisma } from "@/lib/db";
import { forgetPaypalToken } from "@/lib/payments/paypal";
import { draftDueInvoices } from "@/lib/recurring-invoices";
import { seal } from "@/lib/secret-box";

const ORIGIN = "https://www.example.test";
const KEY = "a".repeat(32);
let originalKey: string | undefined;

let paypal: FakePaypal;
let org: { id: string; name: string; currency: string; locale: string };
let ownerId: string;
let clientId: string;

const noon = (days = 0) => {
  const date = addDays(new Date(), days);
  date.setHours(12, 0, 0, 0);
  return date;
};

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

/** A $120 monthly lawn-care series whose next draft is `next`. */
async function makeSeries(options: { next?: Date; endDate?: Date | null; frequency?: string; interval?: number } = {}) {
  const next = options.next ?? noon(0);
  const schedule = await prisma.invoiceSchedule.create({
    data: {
      organizationId: org.id,
      frequency: options.frequency ?? "MONTHLY",
      interval: options.interval ?? 1,
      anchorDate: next,
      nextIssueDate: next,
      endDate: options.endDate ?? null,
      createdById: ownerId,
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      organizationId: org.id,
      clientId,
      scheduleId: schedule.id,
      number: `INV-${randomUUID().slice(0, 8)}`,
      title: "Monthly lawn care",
      status: "SENT",
      issueDate: noon(-30),
      dueDate: noon(-16),
      paymentTermsDays: 14,
      subtotalCents: 12_000,
      totalCents: 12_000,
      balanceCents: 12_000,
      createdById: ownerId,
      lineItems: {
        create: [{ kind: "SERVICE", name: "Mowing", quantity: 1, unit: "mo", unitPriceCents: 12_000, taxable: false, totalCents: 12_000, sortOrder: 0 }],
      },
    },
  });
  return { schedule, invoice };
}

/** Offers auto-pay and returns the invite token. */
async function offer(scheduleId: string) {
  const offered = await offerAutopay({ organization: org, scheduleId, actorId: ownerId });
  if (!offered.ok) throw new Error(offered.error);
  return offered.value.token;
}

/** The customer pressing the invite's button. Returns where they were sent. */
async function click(token: string) {
  const response = await start(new Request(`${ORIGIN}/share/autopay/${token}/start`), {
    params: Promise.resolve({ token }),
  });
  return response.headers.get("location") ?? "";
}

const subscriptionsOf = (scheduleId: string) =>
  prisma.autopaySubscription.findMany({ where: { scheduleId }, orderBy: { createdAt: "asc" } });

const paymentsOf = (invoiceId: string) => prisma.payment.findMany({ where: { invoiceId } });

beforeAll(() => {
  originalKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY;
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

beforeEach(async () => {
  paypal = await startFakePaypal();
  process.env.PAYPAL_API_BASE = paypal.baseUrl;
  forgetPaypalToken();

  const created = await prisma.organization.create({
    data: { slug: `autopay-${randomUUID()}`, name: "Greenline Lawns", billingExempt: true },
  });
  org = created;
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
  session.org = created;
  session.user = owner;

  const client = await prisma.client.create({
    data: { organizationId: org.id, displayName: "Priya Raman", type: "PERSON", email: "priya@example.test" },
  });
  clientId = client.id;

  await connectPaypal(org.id);
});

afterEach(async () => {
  delete process.env.PAYPAL_API_BASE;
  forgetPaypalToken();
  await paypal.close();
});

// ------------------------------------------------------------------ offer ---

describe("offering auto-pay", () => {
  it("makes a PayPal plan for the latest invoice's amount, on the series' rhythm", async () => {
    const { schedule } = await makeSeries({ frequency: "WEEKLY", interval: 2 });

    const token = await offer(schedule.id);

    expect(token).toHaveLength(32);
    const [plan] = [...paypal.plans.values()] as {
      billing_cycles: { frequency: unknown; pricing_scheme: { fixed_price: unknown }; total_cycles: number }[];
    }[];
    expect(plan.billing_cycles[0]).toMatchObject({
      frequency: { interval_unit: "WEEK", interval_count: 2 },
      pricing_scheme: { fixed_price: { value: "120.00", currency_code: "USD" } },
      total_cycles: 0,
    });

    const saved = await prisma.invoiceSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(saved).toMatchObject({ autopayToken: token, autopayAmountCents: 12_000 });
    expect(saved.autopayPlanId).toMatch(/^P-TEST/);

    // Offering charges nobody and makes no subscription.
    expect(paypal.subscriptions.size).toBe(0);
  });

  it("refuses without PayPal connected, and on a rhythm PayPal cannot bill", async () => {
    const { schedule } = await makeSeries({ frequency: "MONTHLY", interval: 18 });
    const tooFar = await offerAutopay({ organization: org, scheduleId: schedule.id, actorId: ownerId });
    expect(tooFar).toMatchObject({ ok: false });

    await prisma.integration.deleteMany({ where: { organizationId: org.id } });
    const other = await makeSeries();
    const unconnected = await offerAutopay({ organization: org, scheduleId: other.schedule.id, actorId: ownerId });
    expect(unconnected.ok === false && unconnected.error).toMatch(/Connect PayPal/);
    expect(paypal.plans.size).toBe(0);
  });
});

// ----------------------------------------------------------------- invite ---

describe("the customer's invite", () => {
  it("describes what they are agreeing to", async () => {
    const { schedule } = await makeSeries({ next: noon(5) });
    const token = await offer(schedule.id);

    const invite = await autopayInvite(token);

    expect(invite).toMatchObject({
      clientName: "Priya Raman",
      what: "Monthly lawn care",
      amountCents: 12_000,
      rhythm: "every month",
      alreadyOn: false,
    });
    expect(format(invite!.firstPayment, "yyyy-MM-dd")).toBe(format(noon(5), "yyyy-MM-dd"));
  });

  it("makes the subscription when clicked, starting on the next invoice's date", async () => {
    const { schedule } = await makeSeries({ next: noon(5) });
    const token = await offer(schedule.id);

    const location = await click(token);

    expect(location).toMatch(/^https:\/\/www\.paypal\.com\/webapps\/billing\/subscriptions\?ba_token=/);
    const [row] = await subscriptionsOf(schedule.id);
    expect(row).toMatchObject({ status: "APPROVAL_PENDING", amountCents: 12_000 });

    const made = paypal.subscriptions.get(row.externalId)!;
    expect(made.body).toMatchObject({
      custom_id: schedule.id,
      start_time: noon(5).toISOString(),
      subscriber: { email_address: "priya@example.test" },
      application_context: {
        return_url: `${ORIGIN}/share/autopay/${token}?done=1`,
        cancel_url: `${ORIGIN}/share/autopay/${token}?cancelled=1`,
      },
    });
    // No end date, so no payment count: it runs until cancelled.
    expect(made.body.plan).toBeUndefined();
  });

  it("gives a repeat with an end date exactly its remaining payments", async () => {
    const { schedule } = await makeSeries({ next: noon(5), endDate: addDays(noon(5), 70) });
    const token = await offer(schedule.id);

    await click(token);

    const [row] = await subscriptionsOf(schedule.id);
    const made = paypal.subscriptions.get(row.externalId)!;
    // Day 5, then a month on, then two months on: day 70 is past the third.
    expect(made.body.plan).toMatchObject({ billing_cycles: [{ sequence: 1, total_cycles: 3 }] });
    expect(paymentsUntil(schedule, noon(5), addDays(noon(5), 70))).toBe(3);
  });

  it("hands out the same approval again for a second click soon after", async () => {
    const { schedule } = await makeSeries({ next: noon(5) });
    const token = await offer(schedule.id);

    const first = await click(token);
    const second = await click(token);

    expect(second).toBe(first);
    expect(await subscriptionsOf(schedule.id)).toHaveLength(1);
  });

  it("sends somebody already on auto-pay back to the invite, making nothing", async () => {
    const { schedule } = await makeSeries({ next: noon(5) });
    const token = await offer(schedule.id);
    await click(token);
    const [row] = await subscriptionsOf(schedule.id);
    paypal.approve(row.externalId);
    await syncAutopay({ scheduleId: schedule.id });

    const location = await click(token);

    expect(location).toBe(`${ORIGIN}/share/autopay/${token}`);
    expect(await subscriptionsOf(schedule.id)).toHaveLength(1);
    expect((await autopayInvite(token))?.alreadyOn).toBe(true);
  });

  it("does not work once auto-pay has been withdrawn", async () => {
    const { schedule } = await makeSeries({ next: noon(5) });
    const token = await offer(schedule.id);

    await turnOffAutopay({ organizationId: org.id, scheduleId: schedule.id, actorId: ownerId, reason: "test" });

    expect(await autopayInvite(token)).toBeNull();
    await click(token);
    expect(await subscriptionsOf(schedule.id)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ money ---

describe("collecting", () => {
  it("tells the business when the customer turns it on", async () => {
    const { schedule } = await makeSeries({ next: noon(5) });
    await click(await offer(schedule.id));
    const [row] = await subscriptionsOf(schedule.id);

    paypal.approve(row.externalId, "priya.pays@example.test");
    await syncAutopay({ organizationId: org.id });

    const saved = await prisma.autopaySubscription.findUniqueOrThrow({ where: { id: row.id } });
    expect(saved).toMatchObject({ status: "ACTIVE", payerEmail: "priya.pays@example.test" });

    const notes = await prisma.notification.findMany({ where: { organizationId: org.id, type: "AUTOPAY" } });
    expect(notes.map((note) => note.title)).toEqual(["Priya Raman turned on auto-pay"]);

    const status = await autopayStatus(org.id, schedule);
    expect(status).toMatchObject({ state: "on", amountCents: 12_000 });
  });

  it("records each charge on its own period's invoice, once, and marks it paid", async () => {
    const { schedule, invoice: before } = await makeSeries({ next: noon(0) });
    await click(await offer(schedule.id));
    const [row] = await subscriptionsOf(schedule.id);
    paypal.approve(row.externalId);

    // The morning run: today's draft, then PayPal's charge for it.
    await draftDueInvoices({ organizationId: org.id });
    const draft = await prisma.invoice.findFirstOrThrow({ where: { scheduleId: schedule.id, status: "DRAFT" } });
    paypal.charge(row.externalId, "120.00", "TX-1", new Date());

    await syncAutopay({ organizationId: org.id });
    await syncAutopay({ organizationId: org.id });

    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(paid).toMatchObject({ status: "PAID", balanceCents: 0, amountPaidCents: 12_000 });
    expect(await paymentsOf(draft.id)).toMatchObject([
      { amountCents: 12_000, method: "ONLINE", provider: "PAYPAL", externalId: "TX-1" },
    ]);

    // The invoice from before auto-pay started is not auto-pay's to settle.
    expect(await paymentsOf(before.id)).toEqual([]);

    const notes = await prisma.notification.findMany({
      where: { organizationId: org.id, type: "PAYMENT_RECEIVED" },
    });
    expect(notes.map((note) => note.title)).toEqual([`$120.00 collected by auto-pay on ${draft.number}`]);
  });

  it("does not ask anybody to check and send a draft auto-pay will collect", async () => {
    const { schedule } = await makeSeries({ next: noon(0) });
    await click(await offer(schedule.id));
    const [row] = await subscriptionsOf(schedule.id);
    paypal.approve(row.externalId);
    await syncAutopay({ organizationId: org.id });

    await draftDueInvoices({ organizationId: org.id });

    expect(
      await prisma.notification.count({ where: { organizationId: org.id, type: "INVOICE_DRAFTED" } }),
    ).toBe(0);
  });

  it("waits for the invoice when the charge comes first, then records it", async () => {
    const { schedule } = await makeSeries({ next: noon(0) });
    await click(await offer(schedule.id));
    const [row] = await subscriptionsOf(schedule.id);
    paypal.approve(row.externalId);
    paypal.charge(row.externalId, "120.00", "TX-EARLY", new Date());

    const early = await syncAutopay({ organizationId: org.id });
    expect(early).toMatchObject({ collected: 0, unmatched: 1 });

    await draftDueInvoices({ organizationId: org.id });
    const later = await syncAutopay({ organizationId: org.id });
    expect(later).toMatchObject({ collected: 1, unmatched: 0 });
  });

  it("cancels a second approval rather than charging twice", async () => {
    const { schedule } = await makeSeries({ next: noon(5) });
    const token = await offer(schedule.id);
    await click(token);

    // Hours later the first approval page is stale; a second click makes
    // another. The customer then approves both — two tabs.
    await prisma.autopaySubscription.updateMany({
      where: { scheduleId: schedule.id },
      data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });
    await click(token);
    const [first, second] = await subscriptionsOf(schedule.id);
    paypal.approve(first.externalId);
    paypal.approve(second.externalId);

    await syncAutopay({ organizationId: org.id });

    expect(paypal.subscriptions.get(first.externalId)?.status).toBe("ACTIVE");
    expect(paypal.subscriptions.get(second.externalId)?.status).toBe("CANCELLED");
    expect((await subscriptionsOf(schedule.id)).map((row) => row.status)).toEqual(["ACTIVE", "CANCELLED"]);

    // Told once that it is on, and once about the duplicate — not twice "on".
    const titles = (
      await prisma.notification.findMany({ where: { organizationId: org.id, type: "AUTOPAY" }, orderBy: { createdAt: "asc" } })
    ).map((note) => note.title);
    expect(titles.sort()).toEqual(["Priya Raman set up auto-pay twice", "Priya Raman turned on auto-pay"]);
  });

  it("tells the business when PayPal puts it on hold", async () => {
    const { schedule } = await makeSeries({ next: noon(5) });
    await click(await offer(schedule.id));
    const [row] = await subscriptionsOf(schedule.id);
    paypal.approve(row.externalId);
    await syncAutopay({ organizationId: org.id });

    paypal.setStatus(row.externalId, "SUSPENDED");
    await syncAutopay({ organizationId: org.id });

    const titles = (await prisma.notification.findMany({ where: { organizationId: org.id, type: "AUTOPAY" } })).map(
      (note) => note.title,
    );
    expect(titles).toContain("Auto-pay for Priya Raman is on hold");
    expect(await autopayStatus(org.id, schedule)).toMatchObject({ state: "on-hold" });
  });

  it("stops watching an approval nobody finished, without asking PayPal", async () => {
    const { schedule } = await makeSeries({ next: noon(5) });
    await click(await offer(schedule.id));
    await prisma.autopaySubscription.updateMany({
      where: { scheduleId: schedule.id },
      data: { createdAt: addDays(new Date(), -4) },
    });
    const calls = paypal.requests.length;

    await syncAutopay({ organizationId: org.id });

    expect((await subscriptionsOf(schedule.id)).map((row) => row.status)).toEqual(["EXPIRED"]);
    expect(paypal.requests.length).toBe(calls);
  });
});

// ------------------------------------------------------------------- stop ---

describe("stopping", () => {
  it("cancels at PayPal and takes nothing more", async () => {
    const { schedule } = await makeSeries({ next: noon(5) });
    await click(await offer(schedule.id));
    const [row] = await subscriptionsOf(schedule.id);
    paypal.approve(row.externalId);
    await syncAutopay({ organizationId: org.id });

    const off = await turnOffAutopay({ organizationId: org.id, scheduleId: schedule.id, actorId: ownerId, reason: "test" });

    expect(off.ok).toBe(true);
    expect(paypal.subscriptions.get(row.externalId)?.status).toBe("CANCELLED");
    expect(await autopayStatus(org.id, { ...schedule, autopayToken: null, autopayAmountCents: null })).toMatchObject({
      state: "off",
    });
  });

  it("cancels an old invite approved after auto-pay was turned off", async () => {
    const { schedule } = await makeSeries({ next: noon(5) });
    await click(await offer(schedule.id));
    const [row] = await subscriptionsOf(schedule.id);

    await turnOffAutopay({ organizationId: org.id, scheduleId: schedule.id, actorId: ownerId, reason: "test" });
    // The customer still had PayPal's page open, and approves it anyway.
    paypal.approve(row.externalId);
    await syncAutopay({ organizationId: org.id });

    expect(paypal.subscriptions.get(row.externalId)?.status).toBe("CANCELLED");
  });

  it("will not change or stop the repeat while PayPal is charging on it", async () => {
    const { schedule, invoice } = await makeSeries({ next: noon(5) });
    await click(await offer(schedule.id));
    const [row] = await subscriptionsOf(schedule.id);
    paypal.approve(row.externalId);
    await syncAutopay({ organizationId: org.id });

    const form = new FormData();
    form.set("invoiceId", invoice.id);
    form.set("frequency", "WEEKLY");
    form.set("interval", "1");
    form.set("nextIssueDate", format(noon(3), "yyyy-MM-dd"));
    const changed = await saveInvoiceRepeat(IDLE, form);
    expect(changed.ok === false && changed.error).toMatch(/Turn it off to change the repeat/);

    await stopInvoiceRepeat(form);
    const still = await prisma.invoiceSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(still.isActive).toBe(true);
    expect(paypal.subscriptions.get(row.externalId)?.status).toBe("ACTIVE");
  });

  it("withdraws an offer nobody took up when the repeat is stopped", async () => {
    const { schedule, invoice } = await makeSeries({ next: noon(5) });
    const token = await offer(schedule.id);

    const form = new FormData();
    form.set("invoiceId", invoice.id);
    await stopInvoiceRepeat(form);

    expect(await autopayInvite(token)).toBeNull();
  });
});

import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakePaypal, type FakePaypal } from "./support/paypal-server";

/**
 * Online payments recording themselves.
 *
 * A client pays a PayPal pay link; PayPal tells Matlock One; the invoice is
 * marked paid without anybody pressing anything. Underneath that, the morning
 * run asks about every open link, so a notice that never arrives costs a few
 * hours rather than a client being chased for money they already paid.
 *
 * Driven end to end against the PayPal stand-in: a real pay link is made, the
 * webhook is really registered, and the notice goes through the real route.
 * What the stand-in cannot prove is that PayPal's live notices match its
 * reading of their docs — only a sandbox payment does that.
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

import { POST } from "@/app/api/payments/paypal/webhook/[hook]/route";
import { GET as cron } from "@/app/api/cron/automations/route";
import { checkForPayment } from "@/app/(app)/invoices/payment-link";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import { resolveProcessor } from "@/lib/payments/account";
import { attachPaymentLink } from "@/lib/payments/link";
import { forgetPaypalToken } from "@/lib/payments/paypal";
import {
  ensurePaypalWebhook,
  hookFor,
  noticeFrom,
  organizationForHook,
  webhookAddress,
} from "@/lib/payments/paypal-webhooks";
import { sweepPayLinks } from "@/lib/payments/reconcile";
import { seal } from "@/lib/secret-box";
import type { Organization } from "@/generated/prisma/client";

const KEY = "k".repeat(32);
const APP = "https://app.example.test";
const CRON_SECRET = "c".repeat(32);

const saved: Record<string, string | undefined> = {};
const OVERRIDDEN = ["ENCRYPTION_KEY", "APP_URL", "CRON_SECRET", "VERCEL_ENV"] as const;

let paypal: FakePaypal;
let org: Organization;
let ownerId: string;
let clientId: string;
/** Every business this file made, so their connections can be taken away. */
const made: string[] = [];

async function business(name: string, over: Partial<Organization> = {}) {
  const created = await prisma.organization.create({
    data: { slug: `notice-${randomUUID()}`, name, billingExempt: true, ...over },
  });
  made.push(created.id);
  return created;
}

async function connectPaypal(organizationId: string, config: Record<string, string> = {}) {
  const sealed = seal(JSON.stringify({ clientId: "test-client-id", clientSecret: "test-client-secret" }));
  await prisma.integration.create({
    data: {
      organizationId,
      kind: "PAYMENT",
      provider: "PAYPAL",
      isActive: true,
      config: JSON.stringify({ environment: "sandbox", ...config }),
      secretCipher: sealed.cipherText,
      secretNonce: sealed.nonce,
      secretTag: sealed.tag,
    },
  });
}

/** A sent $120 invoice with a real PayPal pay link on it. */
async function linkedInvoice(
  owner: { org: Organization; clientId: string; createdById?: string | null },
  over: { dueDate?: Date; status?: string } = {},
) {
  const invoice = await prisma.invoice.create({
    data: {
      organizationId: owner.org.id,
      clientId: owner.clientId,
      number: `INV-${randomUUID().slice(0, 8)}`,
      title: "Spring cleanup",
      status: over.status ?? "SENT",
      issueDate: new Date(),
      dueDate: over.dueDate ?? new Date(Date.now() + 14 * 86_400_000),
      subtotalCents: 12_000,
      totalCents: 12_000,
      balanceCents: 12_000,
      createdById: owner.createdById ?? null,
    },
    include: { client: true },
  });

  const linked = await attachPaymentLink(owner.org, invoice);
  if (!linked.ok) throw new Error(`No pay link: ${JSON.stringify(linked)}`);

  const withRef = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  return { id: invoice.id, number: invoice.number, ref: withRef.paymentRef! };
}

/** PayPal delivering a notice to a business's address. */
function deliver(hook: string, body: unknown) {
  return POST(
    new Request(`${APP}/api/payments/paypal/webhook/${hook}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ hook }) },
  );
}

const paidNotice = (paypalInvoiceId: string) => ({
  id: `WH-${randomUUID()}`,
  event_type: "INVOICING.INVOICE.PAID",
  resource_type: "invoices",
  resource: { invoice: { id: paypalInvoiceId, status: "PAID" } },
});

const invoiceRow = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } });
const paymentsOn = (invoiceId: string) => prisma.payment.findMany({ where: { invoiceId } });
const tasksFor = (organizationId: string) => prisma.task.findMany({ where: { organizationId } });

const turnOn = (organizationId: string, templateId: string) =>
  prisma.workflow.create({
    data: { organizationId, templateId, isActive: true, config: JSON.stringify({ days: 7, dueInDays: 1 }) },
  });

beforeAll(() => {
  for (const name of OVERRIDDEN) saved[name] = process.env[name];
});

afterAll(() => {
  for (const name of OVERRIDDEN) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = KEY;
  process.env.APP_URL = APP;
  process.env.CRON_SECRET = CRON_SECRET;
  delete process.env.VERCEL_ENV;

  paypal = await startFakePaypal();
  process.env.PAYPAL_API_BASE = paypal.baseUrl;
  forgetPaypalToken();

  org = await business("Greenline Lawns");
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
  // The test database is shared with every other file. A PayPal connection
  // left behind would have the next file's morning run asking the real PayPal
  // about these invoices once the stand-in has gone.
  await prisma.integration.deleteMany({ where: { organizationId: { in: made } } });
  delete process.env.PAYPAL_API_BASE;
  forgetPaypalToken();
  await paypal.close();
});

// ---------------------------------------------------------------- address ---

describe("the address PayPal is given", () => {
  it("names the business it was made for", () => {
    const hook = hookFor(org.id)!;
    expect(organizationForHook(hook)).toBe(org.id);
  });

  it("refuses an address Matlock One did not make", () => {
    const hook = hookFor(org.id)!;
    const [id, signature] = hook.split(".");
    const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");

    expect(organizationForHook(`${id}.${flipped}`)).toBeNull();
    expect(organizationForHook(id)).toBeNull();
    expect(organizationForHook("../../etc")).toBeNull();
  });

  it("will not let one business's signature vouch for another", () => {
    const signature = hookFor(org.id)!.split(".")[1];
    expect(organizationForHook(`cotherbusiness0000000000.${signature}`)).toBeNull();
  });

  it("stops matching when the key changes", () => {
    const hook = hookFor(org.id)!;
    expect(organizationForHook(hook, { ENCRYPTION_KEY: "z".repeat(32) })).toBeNull();
  });

  it("has nowhere for PayPal to reach on a desktop or a laptop", () => {
    expect(webhookAddress(org.id)).toBe(`${APP}/api/payments/paypal/webhook/${hookFor(org.id)}`);
    expect(webhookAddress(org.id, { ENCRYPTION_KEY: KEY, APP_URL: "http://192.168.1.20:3000" })).toBeNull();
    expect(webhookAddress(org.id, { ENCRYPTION_KEY: KEY, APP_URL: "https://localhost:3000" })).toBeNull();
    expect(webhookAddress(org.id, { ENCRYPTION_KEY: KEY })).toBeNull();
  });

  it("is never registered from a preview deployment", () => {
    // A preview's address dies with the next deploy, leaving a dead webhook on
    // the business's app — and they only get ten.
    expect(
      webhookAddress(org.id, { ENCRYPTION_KEY: KEY, APP_URL: APP, VERCEL_ENV: "preview" }),
    ).toBeNull();
    expect(
      webhookAddress(org.id, { ENCRYPTION_KEY: KEY, APP_URL: APP, VERCEL_ENV: "production" }),
    ).not.toBeNull();
  });
});

describe("reading a notice", () => {
  it("finds the invoice whether or not PayPal wraps it", () => {
    expect(noticeFrom({ event_type: "INVOICING.INVOICE.PAID", resource: { id: "INV2-AB12-CD34" } })).toEqual({
      kind: "invoice",
      paypalInvoiceId: "INV2-AB12-CD34",
    });
    expect(
      noticeFrom({ event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-AB12-CD34" } } }),
    ).toEqual({ kind: "invoice", paypalInvoiceId: "INV2-AB12-CD34" });
  });

  it("finds the subscription an auto-pay charge was for", () => {
    expect(
      noticeFrom({ event_type: "PAYMENT.SALE.COMPLETED", resource: { billing_agreement_id: "I-ABC123" } }),
    ).toEqual({ kind: "subscription", subscriptionId: "I-ABC123" });
  });

  it("ignores everything else", () => {
    expect(noticeFrom({ event_type: "INVOICING.INVOICE.CREATED", resource: { id: "INV2-AB12" } })).toBeNull();
    expect(noticeFrom({ event_type: "INVOICING.INVOICE.PAID", resource: { id: "../admin" } })).toBeNull();
    expect(noticeFrom({ event_type: "PAYMENT.SALE.COMPLETED", resource: {} })).toBeNull();
    expect(noticeFrom(null)).toBeNull();
    expect(noticeFrom("INVOICING.INVOICE.PAID")).toBeNull();
  });
});

// ----------------------------------------------------------- registration ---

describe("registering with PayPal", () => {
  it("registers the business's address on its own PayPal app, once", async () => {
    const processor = (await resolveProcessor(org.id))!;
    const first = await ensurePaypalWebhook(org.id, processor);

    expect(first).toEqual({ ok: true, url: webhookAddress(org.id) });
    const hooks = [...paypal.webhooks.values()];
    expect(hooks).toHaveLength(1);
    expect(hooks[0].url).toBe(webhookAddress(org.id));
    expect(hooks[0].event_types.map((event) => event.name)).toEqual([
      "INVOICING.INVOICE.PAID",
      "PAYMENT.SALE.COMPLETED",
    ]);

    // Remembered, so the next time costs no call to PayPal at all.
    const calls = paypal.requests.length;
    const again = await ensurePaypalWebhook(org.id, (await resolveProcessor(org.id))!);
    expect(again.ok).toBe(true);
    expect(paypal.requests.length).toBe(calls);
  });

  it("finds a webhook that is already there rather than making a second", async () => {
    paypal.webhooks.set("WH-EXISTING", {
      id: "WH-EXISTING",
      url: webhookAddress(org.id)!,
      event_types: [{ name: "INVOICING.INVOICE.PAID" }],
    });

    const result = await ensurePaypalWebhook(org.id, (await resolveProcessor(org.id))!);

    expect(result.ok).toBe(true);
    expect(paypal.webhooks.size).toBe(1);
    // Brought up to date with what this version listens for.
    expect(paypal.webhooks.get("WH-EXISTING")!.event_types.map((event) => event.name)).toEqual([
      "INVOICING.INVOICE.PAID",
      "PAYMENT.SALE.COMPLETED",
    ]);
  });

  it("says what to do when the app already has ten webhooks", async () => {
    for (let i = 0; i < 10; i++) {
      paypal.webhooks.set(`WH-${i}`, { id: `WH-${i}`, url: `https://elsewhere.test/${i}`, event_types: [] });
    }

    const result = await ensurePaypalWebhook(org.id, (await resolveProcessor(org.id))!);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason === "failed" && result.error).toMatch(/ten webhooks/);
  });

  it("does not mark a connection saved since as registered", async () => {
    const processor = (await resolveProcessor(org.id))!;
    // Somebody switches to their live app after the sandbox one was read.
    await prisma.integration.update({
      where: { organizationId_kind: { organizationId: org.id, kind: "PAYMENT" } },
      data: { config: JSON.stringify({ environment: "live" }) },
    });

    const result = await ensurePaypalWebhook(org.id, processor);

    expect(result).toEqual({ ok: false, reason: "changed" });
    expect(paypal.webhooks.size).toBe(0);
    const row = await prisma.integration.findUniqueOrThrow({
      where: { organizationId_kind: { organizationId: org.id, kind: "PAYMENT" } },
    });
    expect(JSON.parse(row.config!)).toEqual({ environment: "live" });
  });

  it("notices new credentials under the same settings", async () => {
    const processor = (await resolveProcessor(org.id))!;
    const resealed = seal(JSON.stringify({ clientId: "another-app", clientSecret: "another-secret" }));
    await prisma.integration.update({
      where: { organizationId_kind: { organizationId: org.id, kind: "PAYMENT" } },
      data: { secretCipher: resealed.cipherText, secretNonce: resealed.nonce, secretTag: resealed.tag },
    });

    expect(await ensurePaypalWebhook(org.id, processor)).toEqual({ ok: false, reason: "changed" });
  });

  it("registers when a pay link is made", async () => {
    await linkedInvoice({ org, clientId });
    expect([...paypal.webhooks.values()].map((hook) => hook.url)).toEqual([webhookAddress(org.id)]);
  });

  it("calls nobody when there is no public address", async () => {
    process.env.APP_URL = "http://localhost:3000";
    const result = await ensurePaypalWebhook(org.id, (await resolveProcessor(org.id))!);

    expect(result).toEqual({ ok: false, reason: "no-address" });
    expect(paypal.webhooks.size).toBe(0);
  });
});

// ------------------------------------------------------------------ notices ---

describe("a payment notice", () => {
  it("marks the invoice paid the moment PayPal says so", async () => {
    const invoice = await linkedInvoice({ org, clientId, createdById: ownerId });
    paypal.pay(invoice.ref, "120.00", "PAY-FULL-1");

    const response = await deliver(hookFor(org.id)!, paidNotice(invoice.ref));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "recorded" });

    const row = await invoiceRow(invoice.id);
    expect(row.status).toBe("PAID");
    expect(row.balanceCents).toBe(0);
    expect(row.paymentCheckedAt).not.toBeNull();

    const payments = await paymentsOn(invoice.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      amountCents: 12_000,
      method: "ONLINE",
      provider: "PAYPAL",
      externalId: "PAY-FULL-1",
      recordedById: null,
    });

    // Whoever raised it hears, and the history says how it was paid.
    const notifications = await prisma.notification.findMany({ where: { userId: ownerId } });
    expect(notifications.map((n) => n.title)).toEqual([`$120.00 paid online on ${invoice.number}`]);
    const logged = await prisma.auditLog.findMany({ where: { entityId: invoice.id, action: "payment.recorded" } });
    expect(logged[0].summary).toMatch(/paid online through PayPal/);
  });

  it("believes PayPal, not the notice", async () => {
    // A notice for an invoice nobody has paid records nothing, whatever it says.
    const invoice = await linkedInvoice({ org, clientId });

    const response = await deliver(hookFor(org.id)!, {
      ...paidNotice(invoice.ref),
      resource: { id: invoice.ref, status: "PAID", amount: { value: "120.00" } },
    });

    expect(await response.json()).toMatchObject({ outcome: "nothing-new" });
    expect(await paymentsOn(invoice.id)).toHaveLength(0);
    expect((await invoiceRow(invoice.id)).status).toBe("SENT");
  });

  it("records a payment once, however many times PayPal repeats the notice", async () => {
    const invoice = await linkedInvoice({ org, clientId });
    paypal.pay(invoice.ref, "120.00", "PAY-ONCE");

    await deliver(hookFor(org.id)!, paidNotice(invoice.ref));
    const second = await deliver(hookFor(org.id)!, paidNotice(invoice.ref));

    expect(await second.json()).toMatchObject({ outcome: "nothing-new" });
    expect(await paymentsOn(invoice.id)).toHaveLength(1);
  });

  it("leaves a part-payment outstanding", async () => {
    const invoice = await linkedInvoice({ org, clientId });
    paypal.pay(invoice.ref, "50.00", "PAY-PART");

    await deliver(hookFor(org.id)!, paidNotice(invoice.ref));

    const row = await invoiceRow(invoice.id);
    expect(row.status).not.toBe("PAID");
    expect(row.amountPaidCents).toBe(5_000);
    expect(row.balanceCents).toBe(7_000);
  });

  it("runs the paid automation, once the last of it is in", async () => {
    // Before this, money that came in online never fired "thank them for
    // paying" — only a payment typed in by hand did.
    await turnOn(org.id, "paid.thank");
    const invoice = await linkedInvoice({ org, clientId });

    paypal.pay(invoice.ref, "50.00", "PAY-A");
    await deliver(hookFor(org.id)!, paidNotice(invoice.ref));
    expect(await tasksFor(org.id)).toHaveLength(0);

    paypal.pay(invoice.ref, "70.00", "PAY-B");
    await deliver(hookFor(org.id)!, paidNotice(invoice.ref));
    const tasks = await tasksFor(org.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toMatch(/Priya Raman/);
  });

  it("asks PayPal again later when PayPal cannot be reached", async () => {
    const invoice = await linkedInvoice({ org, clientId });
    await paypal.close();
    paypal = await startFakePaypal({ failWith: { status: 503, path: "/v2/invoicing/invoices/" } });
    process.env.PAYPAL_API_BASE = paypal.baseUrl;
    forgetPaypalToken();

    const response = await deliver(hookFor(org.id)!, paidNotice(invoice.ref));

    // Not a 200: PayPal resends anything else, which is what should happen.
    expect(response.status).toBe(503);
  });

  it("turns away an address Matlock One did not make, before asking PayPal anything", async () => {
    const invoice = await linkedInvoice({ org, clientId });
    paypal.pay(invoice.ref, "120.00", "PAY-FORGED");
    const before = paypal.requests.length;

    const response = await deliver(`${org.id}.${"A".repeat(32)}`, paidNotice(invoice.ref));

    expect(response.status).toBe(404);
    expect(paypal.requests.length).toBe(before);
    expect(await paymentsOn(invoice.id)).toHaveLength(0);
  });

  it("only acts on the business the address belongs to", async () => {
    // Another business's address, naming this business's invoice.
    const other = await business("Other Co");
    await connectPaypal(other.id);
    const invoice = await linkedInvoice({ org, clientId });
    paypal.pay(invoice.ref, "120.00", "PAY-CROSS");

    const response = await deliver(hookFor(other.id)!, paidNotice(invoice.ref));

    expect(await response.json()).toMatchObject({ outcome: "ignored" });
    expect(await paymentsOn(invoice.id)).toHaveLength(0);
  });

  it("acknowledges what it will never act on, so PayPal stops sending it", async () => {
    const hook = hookFor(org.id)!;

    expect((await deliver(hook, paidNotice("INV2-NOT-OURS"))).status).toBe(200);
    expect((await deliver(hook, { event_type: "INVOICING.INVOICE.CREATED", resource: {} })).status).toBe(200);
    expect((await deliver(hook, "{not json")).status).toBe(400);
  });

  it("waits for a locked business to reopen", async () => {
    const locked = await business("Lapsed Co", {
      billingExempt: false,
      subscriptionPlan: "business",
      paidThrough: new Date(Date.now() - 30 * 86_400_000),
    });
    await connectPaypal(locked.id);
    const client = await prisma.client.create({
      data: { organizationId: locked.id, displayName: "Sam Ortiz", type: "PERSON" },
    });
    const invoice = await linkedInvoice({ org: locked, clientId: client.id });
    paypal.pay(invoice.ref, "120.00", "PAY-LOCKED");

    const response = await deliver(hookFor(locked.id)!, paidNotice(invoice.ref));

    expect(await response.json()).toMatchObject({ outcome: "ignored" });
    expect(await paymentsOn(invoice.id)).toHaveLength(0);
  });
});

// ------------------------------------------------------------ morning run ---

describe("the morning check", () => {
  it("records a payment whose notice never arrived", async () => {
    const invoice = await linkedInvoice({ org, clientId });
    paypal.pay(invoice.ref, "120.00", "PAY-MISSED");

    const result = await sweepPayLinks();

    expect(result.recorded).toBeGreaterThanOrEqual(1);
    expect((await invoiceRow(invoice.id)).status).toBe("PAID");
  });

  it("does not ask about invoices that are already settled", async () => {
    const invoice = await linkedInvoice({ org, clientId });
    paypal.pay(invoice.ref, "120.00", "PAY-DONE");
    await sweepPayLinks();

    const asked = paypal.requests.filter((r) => r.path.endsWith(invoice.ref)).length;
    await sweepPayLinks();

    expect(paypal.requests.filter((r) => r.path.endsWith(invoice.ref)).length).toBe(asked);
  });

  it("stops when its time is up, leaving the rest for next time", async () => {
    await linkedInvoice({ org, clientId });

    const result = await sweepPayLinks({ budgetMs: -1 });

    expect(result.stoppedEarly).toBe(true);
    expect(result.checked).toBe(0);
  });

  it("checks pay links before chasing anybody", async () => {
    // Paid last night, overdue this morning: the notice went astray. The run
    // must find the payment before the overdue automation finds the invoice.
    await turnOn(org.id, "overdue.chase");
    const invoice = await linkedInvoice(
      { org, clientId },
      { dueDate: new Date(Date.now() - 14 * 86_400_000), status: "OVERDUE" },
    );
    paypal.pay(invoice.ref, "120.00", "PAY-OVERNIGHT");

    const response = await cron(
      new Request(`${APP}/api/cron/automations`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );

    expect(response.status).toBe(200);
    expect((await invoiceRow(invoice.id)).status).toBe("PAID");
    expect(await tasksFor(org.id)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ button ---

describe("Check for payment", () => {
  it("records what PayPal reports and runs the paid automation", async () => {
    await turnOn(org.id, "paid.thank");
    const invoice = await linkedInvoice({ org, clientId });
    paypal.pay(invoice.ref, "120.00", "PAY-BUTTON");

    const form = new FormData();
    form.set("invoiceId", invoice.id);
    const state = await checkForPayment(IDLE, form);

    expect(state).toMatchObject({ ok: true, message: "$120.00 recorded — invoice paid in full." });
    expect(await tasksFor(org.id)).toHaveLength(1);
  });

  it("says plainly when there is nothing new", async () => {
    const invoice = await linkedInvoice({ org, clientId });

    const form = new FormData();
    form.set("invoiceId", invoice.id);
    const state = await checkForPayment(IDLE, form);

    expect(state).toMatchObject({ ok: true, message: "Nothing new — PayPal reports no further payments." });
  });

  it("will not ask one processor about another's link", async () => {
    const invoice = await linkedInvoice({ org, clientId });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { paymentProvider: "STRIPE" } });

    const form = new FormData();
    form.set("invoiceId", invoice.id);
    const state = await checkForPayment(IDLE, form);

    expect(state.ok).toBe(false);
    expect(state).toMatchObject({ error: expect.stringMatching(/made through Stripe/) });
  });
});

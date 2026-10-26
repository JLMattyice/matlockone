import { randomUUID } from "node:crypto";

import { addDays, format } from "date-fns";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Send later, and repeats that send themselves.
 *
 * The promises being pinned: a draft goes to the client on its day and not
 * before; it goes once however many runs overlap; the invoice is dated the
 * day it goes; one that cannot go stays a draft and somebody is told, once;
 * sending it by hand or calling it off means the run leaves it alone; and a
 * repeat only sends itself when asked to, never a stack of old ones at once.
 *
 * Driven through the real engine and the real server actions against the
 * test database. The mailbox is stood in for: whether one is connected, and
 * what was handed to it.
 */

const session = vi.hoisted(() => ({
  user: null as unknown as Record<string, unknown>,
  org: null as unknown as Record<string, unknown>,
}));

const mail = vi.hoisted(() => ({
  connected: true,
  refuse: null as string | null,
  sent: [] as { to: string; subject: string; relatedId: string | null; body: string }[],
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

// This machine's own zone, so "tomorrow" in the form is tomorrow for the
// dates below whatever hour the suite runs at.
vi.mock("@/lib/viewer-time-zone", () => ({
  viewerTimeZone: async () => Intl.DateTimeFormat().resolvedOptions().timeZone,
}));

// The PDF is not what is under test, and building one per send is slow.
vi.mock("@/lib/pdf/invoice-document", () => ({ invoicePdfFor: async () => null }));

vi.mock("@/lib/messaging", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/messaging")>();
  return {
    ...actual,
    resolveEmailAccount: async () =>
      mail.connected
        ? { provider: "SMTP", config: { fromEmail: "office@example.test" }, secret: "x" }
        : null,
    sendMessage: async (message: {
      to: string;
      subject?: string;
      body: string;
      relatedId?: string | null;
    }) => {
      if (mail.refuse) return { ok: false, delivered: false, messageId: "m", error: mail.refuse };
      mail.sent.push({
        to: message.to,
        subject: message.subject ?? "",
        body: message.body,
        relatedId: message.relatedId ?? null,
      });
      return { ok: true, delivered: mail.connected, messageId: "m" };
    },
  };
});

import { cancelInvoiceSend, scheduleInvoiceSend, sendInvoice } from "@/app/(app)/invoices/actions";
import { saveInvoiceRepeat } from "@/app/(app)/invoices/repeat";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import { draftDueInvoices, SEND_ITSELF_DAYS } from "@/lib/recurring-invoices";
import { sendScheduledInvoices } from "@/lib/scheduled-invoices";

/** Noon on the day `days` from today, the way every form date is stored. */
const noon = (days = 0) => {
  const date = addDays(new Date(), days);
  date.setHours(12, 0, 0, 0);
  return date;
};

const ymd = (date: Date) => format(date, "yyyy-MM-dd");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
};

let organizationId: string;
let ownerId: string;
let clientId: string;

async function makeBusiness(extra: Record<string, unknown> = {}) {
  const org = await prisma.organization.create({
    data: {
      slug: `later-${randomUUID()}`,
      name: "Send Later Co",
      billingExempt: true,
      ...extra,
    },
  });
  const owner = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `owner-${randomUUID()}@example.test`,
      name: "Morgan Hale",
      passwordHash: "x",
      role: "OWNER",
    },
  });
  const client = await prisma.client.create({
    data: { organizationId: org.id, displayName: "Priya Raman", type: "PERSON", email: "priya@example.test" },
  });
  return { org, owner, client };
}

/** A $120 draft dated today with 14-day terms. */
async function makeDraft(overrides: Record<string, unknown> = {}) {
  return prisma.invoice.create({
    data: {
      organizationId,
      clientId,
      number: `INV-${randomUUID().slice(0, 8)}`,
      title: "Monthly lawn care",
      status: "DRAFT",
      issueDate: noon(0),
      paymentTermsDays: 14,
      dueDate: noon(14),
      subtotalCents: 12_000,
      totalCents: 12_000,
      balanceCents: 12_000,
      createdById: ownerId,
      lineItems: {
        create: [
          { kind: "SERVICE", name: "Mowing", quantity: 4, unit: "visit", unitPriceCents: 3_000, taxable: false, totalCents: 12_000, sortOrder: 0 },
        ],
      },
      ...overrides,
    },
  });
}

/** Sets a draft to go on a day directly, bypassing the form's date rules. */
const setToSend = (invoiceId: string, day: Date, extra: Record<string, unknown> = {}) =>
  prisma.invoice.update({
    where: { id: invoiceId },
    data: { sendOn: day, sendScheduledById: ownerId, ...extra },
  });

const reload = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } });

const mailFor = (invoiceId: string) => mail.sent.filter((m) => m.relatedId === invoiceId);

const notSentNotices = () =>
  prisma.notification.findMany({ where: { organizationId, type: "INVOICE_NOT_SENT" } });

beforeEach(async () => {
  mail.connected = true;
  mail.refuse = null;
  mail.sent.length = 0;

  const { org, owner, client } = await makeBusiness();
  organizationId = org.id;
  ownerId = owner.id;
  clientId = client.id;
  session.org = org;
  session.user = owner;
});

// ------------------------------------------------------------ the form ---

describe("choosing a day", () => {
  it("sets the day, and dates the invoice that day with its terms carried along", async () => {
    const draft = await makeDraft();

    const result = await scheduleInvoiceSend(
      IDLE,
      form({ id: draft.id, email: "priya@example.test", sendOn: ymd(noon(30)) }),
    );

    expect(result.ok).toBe(true);
    const after = await reload(draft.id);
    expect(after.status).toBe("DRAFT");
    expect(ymd(after.sendOn!)).toBe(ymd(noon(30)));
    expect(ymd(after.issueDate)).toBe(ymd(noon(30)));
    expect(ymd(after.dueDate!)).toBe(ymd(noon(44)));
    // The client's own address, so a change to it before the day is followed.
    expect(after.sendTo).toBeNull();
    expect(after.sendScheduledById).toBe(ownerId);
    expect(mail.sent).toHaveLength(0);
  });

  it("keeps an address typed in that is not the client's", async () => {
    const draft = await makeDraft();
    await scheduleInvoiceSend(
      IDLE,
      form({ id: draft.id, email: "accounts@raman.example", sendOn: ymd(noon(3)) }),
    );
    expect((await reload(draft.id)).sendTo).toBe("accounts@raman.example");
  });

  it("refuses today, the past, and more than a year out", async () => {
    const draft = await makeDraft();
    for (const days of [0, -2, 400]) {
      const result = await scheduleInvoiceSend(
        IDLE,
        form({ id: draft.id, email: "priya@example.test", sendOn: ymd(noon(days)) }),
      );
      expect(result.ok).toBe(false);
      expect(result.fieldErrors?.sendOn).toBeTruthy();
    }
    expect((await reload(draft.id)).sendOn).toBeNull();
  });

  it("refuses an invoice already sent, and a business with no mailbox", async () => {
    const sent = await makeDraft({ status: "SENT", sentAt: new Date() });
    expect(
      (await scheduleInvoiceSend(IDLE, form({ id: sent.id, email: "priya@example.test", sendOn: ymd(noon(5)) }))).ok,
    ).toBe(false);

    mail.connected = false;
    const draft = await makeDraft();
    const result = await scheduleInvoiceSend(
      IDLE,
      form({ id: draft.id, email: "priya@example.test", sendOn: ymd(noon(5)) }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/email account/i);
    expect((await reload(draft.id)).sendOn).toBeNull();
  });
});

// ------------------------------------------------------------- the run ---

describe("the morning run", () => {
  it("waits for the day, then sends it once however many runs overlap", async () => {
    const draft = await makeDraft();
    await setToSend(draft.id, noon(2));

    await sendScheduledInvoices();
    expect(mailFor(draft.id)).toHaveLength(0);

    const day = noon(2);
    await Promise.all([
      sendScheduledInvoices({ now: day }),
      sendScheduledInvoices({ now: day }),
      sendScheduledInvoices({ now: day }),
    ]);

    expect(mailFor(draft.id)).toHaveLength(1);
    expect(mailFor(draft.id)[0]!.to).toBe("priya@example.test");
    expect(mailFor(draft.id)[0]!.subject).toContain(draft.number);
    const after = await reload(draft.id);
    expect(after.status).toBe("SENT");
    expect(after.sentAt).not.toBeNull();
    expect(after.sendOn).toBeNull();

    await sendScheduledInvoices({ now: noon(3) });
    expect(mailFor(draft.id)).toHaveLength(1);
  });

  it("uses the address chosen for it", async () => {
    const draft = await makeDraft();
    await setToSend(draft.id, noon(0), { sendTo: "accounts@raman.example" });

    const { sent } = await sendScheduledInvoices();

    expect(sent.map((s) => s.to)).toEqual(["accounts@raman.example"]);
    expect(mailFor(draft.id)[0]!.to).toBe("accounts@raman.example");
  });

  it("leaves it a draft and tells whoever chose the day when it cannot go — once", async () => {
    const draft = await makeDraft();
    await setToSend(draft.id, noon(0));
    mail.connected = false;

    const { sent, failed } = await sendScheduledInvoices();

    expect(sent).toHaveLength(0);
    expect(failed.map((f) => f.id)).toEqual([draft.id]);
    expect(mailFor(draft.id)).toHaveLength(0);
    const after = await reload(draft.id);
    expect(after.status).toBe("DRAFT");
    expect(after.sendOn).toBeNull();

    const notices = await notSentNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.userId).toBe(ownerId);
    expect(notices[0]!.title).toContain(draft.number);
    expect(notices[0]!.actionUrl).toBe(`/invoices/${draft.id}`);

    mail.connected = true;
    await sendScheduledInvoices();
    expect(mailFor(draft.id)).toHaveLength(0);
    expect(await notSentNotices()).toHaveLength(1);
  });

  it("reports a mailbox that refuses it the same way", async () => {
    const draft = await makeDraft();
    await setToSend(draft.id, noon(0));
    mail.refuse = "Mailbox unavailable";

    const { failed } = await sendScheduledInvoices();

    expect(failed[0]!.error).toBe("Mailbox unavailable");
    expect((await reload(draft.id)).status).toBe("DRAFT");
    expect((await notSentNotices())[0]!.body).toContain("Mailbox unavailable");
  });

  it("leaves alone one sent by hand, called off, or cancelled first", async () => {
    const byHand = await makeDraft();
    const calledOff = await makeDraft();
    const cancelled = await makeDraft();
    for (const invoice of [byHand, calledOff, cancelled]) await setToSend(invoice.id, noon(1));

    expect((await sendInvoice(IDLE, form({ id: byHand.id }))).ok).toBe(true);
    expect((await reload(byHand.id)).sendOn).toBeNull();

    await cancelInvoiceSend(form({ id: calledOff.id }));
    expect((await reload(calledOff.id)).sendOn).toBeNull();

    await prisma.invoice.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });

    mail.sent.length = 0;
    await sendScheduledInvoices({ now: noon(1) });

    expect(mail.sent).toHaveLength(0);
    expect((await reload(calledOff.id)).status).toBe("DRAFT");
  });

  it("leaves the demo and a locked business alone", async () => {
    const owner = ownerId;
    const drafts: string[] = [];
    for (const extra of [
      { isDemo: true },
      { billingExempt: false, subscriptionPlan: "starter", paidThrough: noon(-30) },
    ]) {
      const { org, client } = await makeBusiness(extra);
      organizationId = org.id;
      clientId = client.id;
      const draft = await makeDraft();
      await setToSend(draft.id, noon(0), { sendScheduledById: owner });
      drafts.push(draft.id);
    }

    await sendScheduledInvoices();

    for (const id of drafts) {
      expect(mailFor(id)).toHaveLength(0);
      expect((await reload(id)).sendOn).not.toBeNull();
    }
  });
});

// --------------------------------------------------------- the repeats ---

/** Puts an invoice on a schedule directly, bypassing the form's date rules. */
async function repeat(invoiceId: string, next: Date, autoSend: boolean) {
  const schedule = await prisma.invoiceSchedule.create({
    data: {
      organizationId,
      frequency: "MONTHLY",
      interval: 1,
      anchorDate: next,
      nextIssueDate: next,
      autoSend,
      createdById: ownerId,
    },
  });
  await prisma.invoice.update({ where: { id: invoiceId }, data: { scheduleId: schedule.id } });
  return schedule;
}

const inSeries = (scheduleId: string) =>
  prisma.invoice.findMany({ where: { scheduleId }, orderBy: { issueDate: "asc" } });

describe("a repeat that sends itself", () => {
  it("sends each new invoice on its day, without asking anybody to check it", async () => {
    const first = await makeDraft({ status: "SENT", sentAt: noon(-30), issueDate: noon(-30), dueDate: noon(-16) });
    const schedule = await repeat(first.id, noon(0), true);

    await draftDueInvoices();
    await sendScheduledInvoices();

    const series = await inSeries(schedule.id);
    expect(series).toHaveLength(2);
    const made = series[1]!;
    expect(made.status).toBe("SENT");
    expect(made.sendOn).toBeNull();
    expect(ymd(made.issueDate)).toBe(ymd(noon(0)));
    expect(mailFor(made.id)).toHaveLength(1);
    expect(
      await prisma.notification.count({ where: { organizationId, type: "INVOICE_DRAFTED" } }),
    ).toBe(0);
  });

  it("still only drafts when it is not set to", async () => {
    const first = await makeDraft({ status: "SENT", sentAt: noon(-30), issueDate: noon(-30) });
    const schedule = await repeat(first.id, noon(0), false);

    await draftDueInvoices();
    await sendScheduledInvoices();

    const made = (await inSeries(schedule.id))[1]!;
    expect(made.status).toBe("DRAFT");
    expect(made.sendOn).toBeNull();
    expect(mail.sent).toHaveLength(0);
    expect(
      await prisma.notification.count({ where: { organizationId, type: "INVOICE_DRAFTED" } }),
    ).toBe(1);
  });

  it("catching up, sends the last week's and leaves older ones to check", async () => {
    const first = await makeDraft({ status: "SENT", sentAt: noon(-90), issueDate: noon(-90) });
    const schedule = await prisma.invoiceSchedule.create({
      data: {
        organizationId,
        frequency: "WEEKLY",
        interval: 1,
        anchorDate: noon(-(SEND_ITSELF_DAYS + 9)),
        nextIssueDate: noon(-(SEND_ITSELF_DAYS + 9)),
        autoSend: true,
        createdById: ownerId,
      },
    });
    await prisma.invoice.update({ where: { id: first.id }, data: { scheduleId: schedule.id } });

    await draftDueInvoices();
    await sendScheduledInvoices();

    const made = (await inSeries(schedule.id)).slice(1);
    // Dated 16, 9 and 2 days ago: only the last is inside the week.
    expect(made.map((invoice) => invoice.status)).toEqual(["DRAFT", "DRAFT", "SENT"]);
    expect(mail.sent).toHaveLength(1);
    expect(
      await prisma.notification.count({ where: { organizationId, type: "INVOICE_DRAFTED" } }),
    ).toBe(2);
  });

  it("is chosen on the repeat form, which sends today's at once", async () => {
    const first = await makeDraft({ status: "SENT", sentAt: noon(-30), issueDate: noon(-30) });

    const result = await saveInvoiceRepeat(
      IDLE,
      form({
        invoiceId: first.id,
        frequency: "MONTHLY",
        interval: "1",
        nextIssueDate: ymd(noon(0)),
        autoSend: "SEND",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/was sent to priya@example\.test/);
    const schedule = await prisma.invoiceSchedule.findFirstOrThrow({ where: { organizationId } });
    expect(schedule.autoSend).toBe(true);
    const made = (await inSeries(schedule.id))[1]!;
    expect(made.status).toBe("SENT");
    expect(mailFor(made.id)).toHaveLength(1);
  });

  it("is refused on the form without a mailbox or a client address", async () => {
    const first = await makeDraft({ status: "SENT", sentAt: noon(-30), issueDate: noon(-30) });
    const fields = {
      invoiceId: first.id,
      frequency: "MONTHLY",
      interval: "1",
      nextIssueDate: ymd(noon(10)),
      autoSend: "SEND",
    };

    mail.connected = false;
    expect((await saveInvoiceRepeat(IDLE, form(fields))).ok).toBe(false);

    mail.connected = true;
    await prisma.client.update({ where: { id: clientId }, data: { email: null } });
    expect((await saveInvoiceRepeat(IDLE, form(fields))).ok).toBe(false);

    expect(await prisma.invoiceSchedule.count({ where: { organizationId } })).toBe(0);

    // Drafts to check need neither.
    expect((await saveInvoiceRepeat(IDLE, form({ ...fields, autoSend: "DRAFT" }))).ok).toBe(true);
  });
});

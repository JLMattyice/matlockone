import { randomUUID } from "node:crypto";

import { addDays, addMonths, format } from "date-fns";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Repeating invoices.
 *
 * The promises being pinned: each period makes exactly one draft, however
 * many runs overlap; the draft copies the latest invoice in the series and
 * is never sent; a run that was missed catches up, but only so far; the end
 * date, the demo and a locked business are respected; and somebody is told.
 *
 * Driven through the real engine and the real server actions against the
 * test database, signed in as a real owner. Only the request-bound parts of
 * Next are stood in for.
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

import { saveInvoiceRepeat, stopInvoiceRepeat } from "@/app/(app)/invoices/repeat";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import { nextInSeries, nextNotBefore } from "@/lib/recurrence";
import { draftDueInvoices, MAX_DRAFTS_PER_RUN } from "@/lib/recurring-invoices";

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
      slug: `repeat-${randomUUID()}`,
      name: "Repeat Test Co",
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

/** A sent $120 lawn-care invoice with two lines, 14-day terms. */
async function makeInvoice(overrides: Record<string, unknown> = {}) {
  return prisma.invoice.create({
    data: {
      organizationId,
      clientId,
      number: `INV-${randomUUID().slice(0, 8)}`,
      title: "Monthly lawn care",
      status: "SENT",
      issueDate: noon(-30),
      paymentTermsDays: 14,
      dueDate: noon(-16),
      subtotalCents: 12_000,
      totalCents: 12_000,
      balanceCents: 12_000,
      notes: "Thanks for your business",
      createdById: ownerId,
      lineItems: {
        create: [
          { kind: "SERVICE", name: "Mowing", quantity: 4, unit: "visit", unitPriceCents: 2_500, taxable: false, totalCents: 10_000, sortOrder: 0 },
          { kind: "SERVICE", name: "Edging", quantity: 1, unit: "ea", unitPriceCents: 2_000, taxable: false, totalCents: 2_000, sortOrder: 1 },
        ],
      },
      ...overrides,
    },
  });
}

/** Puts an invoice on a schedule directly, bypassing the form's date rules. */
async function repeat(
  invoiceId: string,
  settings: { frequency?: string; interval?: number; next: Date; endDate?: Date | null },
) {
  const schedule = await prisma.invoiceSchedule.create({
    data: {
      organizationId,
      frequency: settings.frequency ?? "MONTHLY",
      interval: settings.interval ?? 1,
      anchorDate: settings.next,
      nextIssueDate: settings.next,
      endDate: settings.endDate ?? null,
      createdById: ownerId,
    },
  });
  await prisma.invoice.update({ where: { id: invoiceId }, data: { scheduleId: schedule.id } });
  return schedule;
}

const drafts = (scheduleId: string) =>
  prisma.invoice.findMany({
    where: { scheduleId, status: "DRAFT" },
    orderBy: { issueDate: "asc" },
    include: { lineItems: { orderBy: { sortOrder: "asc" } } },
  });

beforeEach(async () => {
  const { org, owner, client } = await makeBusiness();
  organizationId = org.id;
  ownerId = owner.id;
  clientId = client.id;
  session.org = org;
  session.user = owner;
});

// ---------------------------------------------------------------- dates ---

describe("the rhythm", () => {
  it("keeps a monthly series on its day through short months", () => {
    const anchor = new Date(2027, 0, 31, 12);
    const feb = nextInSeries(anchor, "MONTHLY", 1, anchor);
    const mar = nextInSeries(feb, "MONTHLY", 1, anchor);
    const apr = nextInSeries(mar, "MONTHLY", 1, anchor);

    expect([feb, mar, apr].map(ymd)).toEqual(["2027-02-28", "2027-03-31", "2027-04-30"]);
  });

  it("steps weeks, quarters and years", () => {
    const start = new Date(2027, 2, 10, 12);

    expect(ymd(nextInSeries(start, "WEEKLY", 2, start))).toBe("2027-03-24");
    expect(ymd(nextInSeries(start, "MONTHLY", 3, start))).toBe("2027-06-10");
    expect(ymd(nextInSeries(start, "YEARLY", 1, start))).toBe("2028-03-10");
  });

  it("offers the first date in the rhythm that has not gone by", () => {
    const issued = new Date(2027, 0, 15, 12);

    // One period on, when that is still ahead.
    expect(ymd(nextNotBefore(issued, "MONTHLY", 1, new Date(2027, 0, 20)))).toBe("2027-02-15");
    // An invoice from long ago rolls forward in its own rhythm.
    expect(ymd(nextNotBefore(issued, "MONTHLY", 1, new Date(2027, 5, 16)))).toBe("2027-07-15");
    // Today counts as not gone by.
    expect(ymd(nextNotBefore(issued, "MONTHLY", 1, new Date(2027, 5, 15)))).toBe("2027-06-15");
  });
});

// ---------------------------------------------------------------- drafts ---

describe("making the drafts", () => {
  it("copies the invoice into a draft on the scheduled date and moves the date on", async () => {
    const invoice = await makeInvoice();
    const schedule = await repeat(invoice.id, { next: noon(0) });

    const result = await draftDueInvoices({ organizationId });

    expect(result.drafted).toHaveLength(1);
    const [draft] = await drafts(schedule.id);

    expect(draft.id).not.toBe(invoice.id);
    expect(draft.number).not.toBe(invoice.number);
    expect(draft).toMatchObject({
      status: "DRAFT",
      title: "Monthly lawn care",
      clientId,
      totalCents: 12_000,
      balanceCents: 12_000,
      amountPaidCents: 0,
      notes: "Thanks for your business",
      createdById: ownerId,
      sentAt: null,
      paymentUrl: null,
    });
    expect(ymd(draft.issueDate)).toBe(ymd(noon(0)));
    expect(ymd(draft.dueDate!)).toBe(ymd(noon(14)));
    expect(draft.lineItems.map((line) => [line.name, line.totalCents])).toEqual([
      ["Mowing", 10_000],
      ["Edging", 2_000],
    ]);

    const after = await prisma.invoiceSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(ymd(after.nextIssueDate)).toBe(ymd(addMonths(noon(0), 1)));
    expect(after.isActive).toBe(true);
  });

  it("sends nothing to the customer", async () => {
    const invoice = await makeInvoice();
    await repeat(invoice.id, { next: noon(0) });

    await draftDueInvoices({ organizationId });

    expect(await prisma.outboxMessage.count({ where: { organizationId } })).toBe(0);
  });

  it("does nothing before the date", async () => {
    const invoice = await makeInvoice();
    const schedule = await repeat(invoice.id, { next: noon(1) });

    expect((await draftDueInvoices({ organizationId })).drafted).toEqual([]);
    expect(await drafts(schedule.id)).toEqual([]);
  });

  it("makes one draft however many runs there are", async () => {
    const invoice = await makeInvoice();
    const schedule = await repeat(invoice.id, { next: noon(0) });

    // Two at once — the morning run and a desktop timer — then one more after.
    await Promise.all([draftDueInvoices({ organizationId }), draftDueInvoices({ organizationId })]);
    await draftDueInvoices({ organizationId });

    expect(await drafts(schedule.id)).toHaveLength(1);
  });

  it("copies the latest invoice in the series, so a price change carries forward", async () => {
    const invoice = await makeInvoice();
    const schedule = await repeat(invoice.id, { frequency: "WEEKLY", next: noon(-7) });

    await draftDueInvoices({ organizationId, now: noon(-7) });
    const [first] = await drafts(schedule.id);

    // The price went up on the draft before it was sent.
    await prisma.invoiceLineItem.updateMany({
      where: { invoiceId: first.id, name: "Mowing" },
      data: { unitPriceCents: 3_000, totalCents: 12_000 },
    });
    await prisma.invoice.update({
      where: { id: first.id },
      data: { subtotalCents: 14_000, totalCents: 14_000, balanceCents: 14_000 },
    });

    await draftDueInvoices({ organizationId });
    const second = (await drafts(schedule.id))[1];

    expect(second.totalCents).toBe(14_000);
    expect(second.lineItems[0].unitPriceCents).toBe(3_000);
  });

  it("skips a cancelled invoice when choosing what to copy", async () => {
    const invoice = await makeInvoice();
    const schedule = await repeat(invoice.id, { frequency: "WEEKLY", next: noon(-7) });

    await draftDueInvoices({ organizationId, now: noon(-7) });
    const [wrong] = await drafts(schedule.id);
    await prisma.invoice.update({
      where: { id: wrong.id },
      data: { status: "CANCELLED", title: "Wrong one", totalCents: 1 },
    });

    await draftDueInvoices({ organizationId });
    const [next] = await drafts(schedule.id);

    expect(next.title).toBe("Monthly lawn care");
    expect(next.totalCents).toBe(12_000);
  });

  it("catches up on missed periods, one draft for each", async () => {
    const invoice = await makeInvoice();
    const schedule = await repeat(invoice.id, { frequency: "WEEKLY", next: noon(-20) });

    const result = await draftDueInvoices({ organizationId });

    expect(result.drafted).toHaveLength(3);
    expect((await drafts(schedule.id)).map((draft) => ymd(draft.issueDate))).toEqual([
      ymd(noon(-20)),
      ymd(noon(-13)),
      ymd(noon(-6)),
    ]);
    const after = await prisma.invoiceSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(ymd(after.nextIssueDate)).toBe(ymd(noon(1)));
  });

  it("catches up only so far in one run", async () => {
    const invoice = await makeInvoice();
    const schedule = await repeat(invoice.id, { frequency: "WEEKLY", next: noon(-7 * 30) });

    await draftDueInvoices({ organizationId });

    expect(await drafts(schedule.id)).toHaveLength(MAX_DRAFTS_PER_RUN);
  });

  it("stops after the end date", async () => {
    const invoice = await makeInvoice();
    const schedule = await repeat(invoice.id, {
      frequency: "WEEKLY",
      next: noon(-14),
      endDate: noon(-7),
    });

    await draftDueInvoices({ organizationId });

    expect((await drafts(schedule.id)).map((draft) => ymd(draft.issueDate))).toEqual([
      ymd(noon(-14)),
      ymd(noon(-7)),
    ]);
    const after = await prisma.invoiceSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(after.isActive).toBe(false);
  });

  it("stops when every invoice in the series has been deleted", async () => {
    const invoice = await makeInvoice();
    const schedule = await repeat(invoice.id, { next: noon(0) });
    await prisma.invoice.delete({ where: { id: invoice.id } });

    expect((await draftDueInvoices({ organizationId })).drafted).toEqual([]);
    const after = await prisma.invoiceSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(after.isActive).toBe(false);
    expect(ymd(after.nextIssueDate)).toBe(ymd(noon(0)));
  });

  it("leaves the demo and a locked business alone", async () => {
    for (const extra of [
      { isDemo: true },
      { billingExempt: false, subscriptionPlan: "starter", paidThrough: noon(-30) },
    ]) {
      const other = await makeBusiness(extra);
      organizationId = other.org.id;
      ownerId = other.owner.id;
      clientId = other.client.id;

      const invoice = await makeInvoice();
      const schedule = await repeat(invoice.id, { next: noon(0) });

      await draftDueInvoices();
      expect(await drafts(schedule.id)).toEqual([]);
    }
  });
});

// --------------------------------------------------------------- telling ---

describe("telling somebody", () => {
  it("notifies whoever set the repeat up, with a link to the draft", async () => {
    const invoice = await makeInvoice();
    const schedule = await repeat(invoice.id, { next: noon(0) });

    await draftDueInvoices({ organizationId });
    const [draft] = await drafts(schedule.id);

    const notes = await prisma.notification.findMany({ where: { organizationId } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      userId: ownerId,
      type: "INVOICE_DRAFTED",
      actionUrl: `/invoices/${draft.id}`,
    });
    expect(notes[0].title).toBe(`Invoice ${draft.number} for Priya Raman is ready to check`);
  });

  it("notifies everyone who can send invoices when that person has gone", async () => {
    const invoice = await makeInvoice();
    const schedule = await repeat(invoice.id, { next: noon(0) });
    await prisma.user.update({ where: { id: ownerId }, data: { isActive: false } });

    const admin = await prisma.user.create({
      data: { organizationId, email: `a-${randomUUID()}@example.test`, name: "Ada", passwordHash: "x", role: "ADMIN" },
    });
    await prisma.user.create({
      data: { organizationId, email: `t-${randomUUID()}@example.test`, name: "Tech", passwordHash: "x", role: "EMPLOYEE" },
    });

    await draftDueInvoices({ organizationId });

    const notes = await prisma.notification.findMany({ where: { organizationId } });
    expect(notes.map((note) => note.userId)).toEqual([admin.id]);
    expect(await drafts(schedule.id)).toHaveLength(1);
  });
});

// --------------------------------------------------------------- actions ---

describe("setting it up from the invoice", () => {
  it("starts a repeat in the future without making anything yet", async () => {
    const invoice = await makeInvoice();

    const state = await saveInvoiceRepeat(
      IDLE,
      form({ invoiceId: invoice.id, frequency: "MONTHLY", interval: "1", nextIssueDate: ymd(noon(10)) }),
    );

    expect(state.ok).toBe(true);
    expect(state.message).toContain("Repeating every month");
    const saved = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      include: { schedule: true },
    });
    expect(saved.schedule).toMatchObject({ frequency: "MONTHLY", interval: 1, isActive: true, createdById: ownerId });
    expect(ymd(saved.schedule!.nextIssueDate)).toBe(ymd(noon(10)));
    expect(await drafts(saved.scheduleId!)).toEqual([]);
  });

  it("makes today's draft straight away when the next date is today", async () => {
    const invoice = await makeInvoice();

    const state = await saveInvoiceRepeat(
      IDLE,
      form({ invoiceId: invoice.id, frequency: "MONTHLY", interval: "1", nextIssueDate: ymd(noon(0)) }),
    );

    const saved = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const [draft] = await drafts(saved.scheduleId!);
    expect(state.message).toBe(`Repeating every month. Today's draft, ${draft.number}, is ready to check.`);
  });

  it("refuses a date long gone, an end before the start, and a cancelled invoice", async () => {
    const invoice = await makeInvoice();

    const past = await saveInvoiceRepeat(
      IDLE,
      form({ invoiceId: invoice.id, frequency: "MONTHLY", interval: "1", nextIssueDate: ymd(noon(-40)) }),
    );
    expect(past.fieldErrors?.nextIssueDate).toBe("Pick today or a later date.");

    const backwards = await saveInvoiceRepeat(
      IDLE,
      form({
        invoiceId: invoice.id,
        frequency: "MONTHLY",
        interval: "1",
        nextIssueDate: ymd(noon(10)),
        endDate: ymd(noon(5)),
      }),
    );
    expect(backwards.fieldErrors?.endDate).toMatch(/before the next invoice/);

    const cancelled = await makeInvoice({ status: "CANCELLED" });
    const refused = await saveInvoiceRepeat(
      IDLE,
      form({ invoiceId: cancelled.id, frequency: "MONTHLY", interval: "1", nextIssueDate: ymd(noon(10)) }),
    );
    expect(refused.ok).toBe(false);

    expect(await prisma.invoiceSchedule.count({ where: { organizationId } })).toBe(0);
  });

  it("changes the one schedule rather than starting a second", async () => {
    const invoice = await makeInvoice();
    const submit = (fields: Record<string, string>) =>
      saveInvoiceRepeat(IDLE, form({ invoiceId: invoice.id, interval: "1", ...fields }));

    await submit({ frequency: "MONTHLY", nextIssueDate: ymd(noon(10)) });
    await submit({ frequency: "WEEKLY", interval: "2", nextIssueDate: ymd(noon(3)) });

    const schedules = await prisma.invoiceSchedule.findMany({ where: { organizationId } });
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ frequency: "WEEKLY", interval: 2 });
    expect(ymd(schedules[0].anchorDate)).toBe(ymd(noon(3)));
  });

  it("stops, keeping every invoice already made", async () => {
    const invoice = await makeInvoice();
    await saveInvoiceRepeat(
      IDLE,
      form({ invoiceId: invoice.id, frequency: "MONTHLY", interval: "1", nextIssueDate: ymd(noon(0)) }),
    );

    await stopInvoiceRepeat(form({ invoiceId: invoice.id }));

    const saved = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      include: { schedule: true },
    });
    expect(saved.schedule?.isActive).toBe(false);
    expect(await drafts(saved.scheduleId!)).toHaveLength(1);

    // And a stopped schedule makes nothing, even once its date has come.
    await draftDueInvoices({ organizationId, now: addMonths(new Date(), 2) });
    expect(await drafts(saved.scheduleId!)).toHaveLength(1);
  });
});

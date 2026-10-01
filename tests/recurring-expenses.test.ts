import { randomUUID } from "node:crypto";

import { addDays, addMonths, format } from "date-fns";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Repeating expenses.
 *
 * The promises being pinned: a fixed bill is recorded once per period, copied
 * from the latest in its series, however many runs overlap; a bill whose
 * amount changes records nothing and raises one task per period instead, and
 * entering the bill from that task joins the series and ticks the task off;
 * a missed run catches up, but only so far; the end date, the demo and a
 * locked business are respected.
 *
 * Driven through the real engine and the real server actions against the
 * test database, signed in as a real owner.
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

import { createExpense } from "@/app/(app)/expenses/actions";
import { saveExpenseRepeat, stopExpenseRepeat } from "@/app/(app)/expenses/repeat";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import { MAX_PER_RUN, monthlyEquivalentCents, recordDueExpenses } from "@/lib/recurring-expenses";

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

async function makeBusiness(extra: Record<string, unknown> = {}) {
  const org = await prisma.organization.create({
    data: { slug: `bills-${randomUUID()}`, name: "Bills Test Co", billingExempt: true, ...extra },
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
  return { org, owner };
}

/** A $59.99 software subscription paid by card, dated `spentAt`. */
function makeExpense(overrides: Record<string, unknown> = {}, orgId = organizationId) {
  return prisma.expense.create({
    data: {
      organizationId: orgId,
      description: "Design software",
      category: "SOFTWARE",
      vendor: "Adobe",
      amountCents: 5_999,
      taxCents: 400,
      method: "CARD",
      reference: "INV-88123",
      spentAt: noon(-30),
      createdById: ownerId,
      ...overrides,
    },
  });
}

/** A schedule on an existing expense, due `next`. */
async function makeSchedule(
  expenseId: string,
  next: Date,
  options: { amountVaries?: boolean; endDate?: Date | null; orgId?: string } = {},
) {
  const schedule = await prisma.expenseSchedule.create({
    data: {
      organizationId: options.orgId ?? organizationId,
      frequency: "MONTHLY",
      interval: 1,
      anchorDate: next,
      nextDate: next,
      endDate: options.endDate ?? null,
      amountVaries: options.amountVaries ?? false,
      createdById: ownerId,
    },
  });
  await prisma.expense.update({ where: { id: expenseId }, data: { scheduleId: schedule.id } });
  return schedule;
}

const seriesOf = (scheduleId: string) =>
  prisma.expense.findMany({ where: { scheduleId }, orderBy: { spentAt: "asc" } });

const remindersFor = (scheduleId: string) =>
  prisma.task.findMany({ where: { expenseScheduleId: scheduleId }, orderBy: { dueAt: "asc" } });

beforeEach(async () => {
  const { org, owner } = await makeBusiness();
  organizationId = org.id;
  ownerId = owner.id;
  session.org = org;
  session.user = owner;
});

// --------------------------------------------------------------- fixed bills ---

describe("a bill with the same amount every time", () => {
  it("is recorded on its date, copied from the latest in the series", async () => {
    const first = await makeExpense();
    const schedule = await makeSchedule(first.id, noon(0));

    const result = await recordDueExpenses({ organizationId });

    expect(result.done).toHaveLength(1);
    expect(result.done[0].kind).toBe("recorded");
    const series = await seriesOf(schedule.id);
    expect(series).toHaveLength(2);
    expect(series[1]).toMatchObject({
      description: "Design software",
      vendor: "Adobe",
      category: "SOFTWARE",
      amountCents: 5_999,
      taxCents: 400,
      method: "CARD",
      // A receipt number belongs to one receipt.
      reference: null,
    });
    expect(ymd(series[1].spentAt)).toBe(ymd(noon(0)));

    const moved = await prisma.expenseSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(ymd(moved.nextDate)).toBe(ymd(addMonths(noon(0), 1)));
  });

  it("carries a price change forward", async () => {
    const first = await makeExpense();
    const schedule = await makeSchedule(first.id, noon(0));
    // The price went up: the latest one in the series says so.
    await makeExpense({ amountCents: 6_999, spentAt: noon(-1), scheduleId: schedule.id });

    await recordDueExpenses({ organizationId });

    const series = await seriesOf(schedule.id);
    expect(series.at(-1)?.amountCents).toBe(6_999);
  });

  it("records each period once, however many runs overlap", async () => {
    const first = await makeExpense();
    const schedule = await makeSchedule(first.id, noon(0));

    await Promise.all([
      recordDueExpenses({ organizationId }),
      recordDueExpenses({ organizationId }),
      recordDueExpenses({ organizationId }),
    ]);

    expect(await seriesOf(schedule.id)).toHaveLength(2);
  });

  it("does nothing before its date", async () => {
    const first = await makeExpense();
    const schedule = await makeSchedule(first.id, noon(3));

    const result = await recordDueExpenses({ organizationId });

    expect(result.done).toHaveLength(0);
    expect(await seriesOf(schedule.id)).toHaveLength(1);
  });

  it("catches up on missed months, but only so far in one run", async () => {
    const first = await makeExpense({ spentAt: addMonths(noon(0), -20) });
    const schedule = await makeSchedule(first.id, addMonths(noon(0), -15));

    const result = await recordDueExpenses({ organizationId });

    expect(result.done).toHaveLength(MAX_PER_RUN);
    expect(await seriesOf(schedule.id)).toHaveLength(MAX_PER_RUN + 1);
  });

  it("stops at its end date", async () => {
    const first = await makeExpense();
    const schedule = await makeSchedule(first.id, noon(-40), { endDate: noon(-20) });

    await recordDueExpenses({ organizationId });

    // The one on its date before the end; nothing after it.
    expect(await seriesOf(schedule.id)).toHaveLength(2);
    const ended = await prisma.expenseSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(ended.isActive).toBe(false);
  });

  it("stops when every expense in the series has been deleted", async () => {
    const first = await makeExpense();
    const schedule = await makeSchedule(first.id, noon(0));
    await prisma.expense.delete({ where: { id: first.id } });

    await recordDueExpenses({ organizationId });

    const stopped = await prisma.expenseSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(stopped.isActive).toBe(false);
    expect(await seriesOf(schedule.id)).toHaveLength(0);
  });

  it("does not owe a reimbursement to somebody who has left", async () => {
    const leaver = await prisma.user.create({
      data: {
        organizationId,
        email: `leaver-${randomUUID()}@example.test`,
        name: "Sam Ortiz",
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: false,
      },
    });
    const first = await makeExpense({ reimbursable: true, paidById: leaver.id });
    const schedule = await makeSchedule(first.id, noon(0));

    await recordDueExpenses({ organizationId });

    const latest = (await seriesOf(schedule.id)).at(-1)!;
    expect(latest.paidById).toBeNull();
    expect(latest.reimbursable).toBe(false);
  });
});

// ------------------------------------------------------------ changing bills ---

describe("a bill whose amount changes", () => {
  it("records nothing, and raises a task to enter it", async () => {
    const first = await makeExpense({
      description: "Electric bill",
      category: "UTILITIES",
      vendor: "Duke Energy",
      amountCents: 14_230,
    });
    const schedule = await makeSchedule(first.id, noon(0), { amountVaries: true });

    const result = await recordDueExpenses({ organizationId });

    expect(result.done.map((item) => item.kind)).toEqual(["reminder"]);
    expect(await seriesOf(schedule.id)).toHaveLength(1);

    const [task] = await remindersFor(schedule.id);
    expect(task.title).toBe(`Enter Electric bill for ${format(noon(0), "MMM d")}`);
    expect(task.notes).toBe("Last time: $142.30 to Duke Energy.");
    expect(task.status).toBe("OPEN");
    expect(task.assignedToId).toBe(ownerId);

    const [notice] = await prisma.notification.findMany({ where: { userId: ownerId } });
    expect(notice.type).toBe("EXPENSE_DUE");
    expect(notice.actionUrl).toBe(`/expenses/new?repeat=${schedule.id}&date=${ymd(noon(0))}`);
  });

  it("raises one task per period, however many runs overlap", async () => {
    const first = await makeExpense({ category: "UTILITIES" });
    const schedule = await makeSchedule(first.id, noon(0), { amountVaries: true });

    await Promise.all([recordDueExpenses({ organizationId }), recordDueExpenses({ organizationId })]);

    expect(await remindersFor(schedule.id)).toHaveLength(1);
  });

  it("joins the series and ticks off the task when the bill is entered", async () => {
    const first = await makeExpense({
      description: "Electric bill",
      category: "UTILITIES",
      spentAt: noon(-65),
    });
    const schedule = await makeSchedule(first.id, noon(-35), { amountVaries: true });
    await recordDueExpenses({ organizationId });
    // Two months went by: two bills to enter, oldest first.
    expect(await remindersFor(schedule.id)).toHaveLength(2);

    await expect(
      createExpense(
        IDLE,
        form({
          description: "Electric bill",
          category: "UTILITIES",
          amount: "151.08",
          method: "CARD",
          spentAt: ymd(noon(-35)),
          scheduleId: schedule.id,
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const series = await seriesOf(schedule.id);
    expect(series.map((expense) => expense.amountCents)).toEqual([5_999, 15_108]);

    const [older, newer] = await remindersFor(schedule.id);
    expect(older.status).toBe("DONE");
    expect(older.completedById).toBe(ownerId);
    expect(newer.status).toBe("OPEN");
  });

  it("will not join a series belonging to another business", async () => {
    const other = await makeBusiness();
    const theirs = await makeExpense({}, other.org.id);
    const schedule = await makeSchedule(theirs.id, noon(0), { amountVaries: true, orgId: other.org.id });

    await expect(
      createExpense(
        IDLE,
        form({
          description: "Electric bill",
          category: "UTILITIES",
          amount: "10.00",
          method: "CARD",
          spentAt: ymd(noon(0)),
          scheduleId: schedule.id,
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(await seriesOf(schedule.id)).toHaveLength(1);
  });
});

// --------------------------------------------------------------------- scope ---

describe("who it runs for", () => {
  it("leaves the demo alone", async () => {
    const demo = await makeBusiness({ isDemo: true });
    const expense = await makeExpense({}, demo.org.id);
    const schedule = await makeSchedule(expense.id, noon(0), { orgId: demo.org.id });

    await recordDueExpenses();

    expect(await seriesOf(schedule.id)).toHaveLength(1);
  });

  it("waits for a locked business to reopen", async () => {
    const locked = await makeBusiness({
      billingExempt: false,
      subscriptionPlan: "business",
      paidThrough: noon(-30),
    });
    const expense = await makeExpense({}, locked.org.id);
    const schedule = await makeSchedule(expense.id, noon(0), { orgId: locked.org.id });

    await recordDueExpenses({ organizationId: locked.org.id });

    expect(await seriesOf(schedule.id)).toHaveLength(1);
    const waiting = await prisma.expenseSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(ymd(waiting.nextDate)).toBe(ymd(noon(0)));
  });
});

// ------------------------------------------------------------------- actions ---

describe("setting a repeat", () => {
  it("starts one, and does today's straight away", async () => {
    const expense = await makeExpense();

    const state = await saveExpenseRepeat(
      IDLE,
      form({
        expenseId: expense.id,
        frequency: "MONTHLY",
        interval: "1",
        nextDate: ymd(noon(0)),
        amountVaries: "FIXED",
      }),
    );

    expect(state).toMatchObject({ ok: true, message: "Repeating every month. Today's has been recorded." });
    const linked = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(await seriesOf(linked.scheduleId!)).toHaveLength(2);
  });

  it("remembers a bill whose amount changes", async () => {
    const expense = await makeExpense({ category: "UTILITIES" });

    const state = await saveExpenseRepeat(
      IDLE,
      form({
        expenseId: expense.id,
        frequency: "MONTHLY",
        interval: "1",
        nextDate: ymd(noon(10)),
        amountVaries: "VARIES",
      }),
    );

    expect(state.ok).toBe(true);
    expect(state.message).toMatch(/reminded to enter the next one/);
    const linked = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
      include: { schedule: true },
    });
    expect(linked.schedule?.amountVaries).toBe(true);
  });

  it("refuses a date long gone, which would catch up every period since", async () => {
    const expense = await makeExpense();

    const state = await saveExpenseRepeat(
      IDLE,
      form({
        expenseId: expense.id,
        frequency: "MONTHLY",
        interval: "1",
        nextDate: ymd(noon(-90)),
        amountVaries: "FIXED",
      }),
    );

    expect(state.ok).toBe(false);
    expect(state.fieldErrors?.nextDate).toBeDefined();
  });

  it("will not touch another business's expense", async () => {
    const other = await makeBusiness();
    const theirs = await makeExpense({}, other.org.id);

    const state = await saveExpenseRepeat(
      IDLE,
      form({
        expenseId: theirs.id,
        frequency: "MONTHLY",
        interval: "1",
        nextDate: ymd(noon(5)),
        amountVaries: "FIXED",
      }),
    );

    expect(state).toMatchObject({ ok: false, error: "That expense no longer exists." });
  });

  it("stops, keeping what was already recorded", async () => {
    const first = await makeExpense();
    const schedule = await makeSchedule(first.id, noon(0));
    await recordDueExpenses({ organizationId });

    await stopExpenseRepeat(form({ expenseId: first.id }));

    const stopped = await prisma.expenseSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(stopped.isActive).toBe(false);
    expect(await seriesOf(schedule.id)).toHaveLength(2);
  });
});

describe("the monthly figure", () => {
  it("puts every rhythm on a per-month footing", () => {
    expect(monthlyEquivalentCents(1_200, "MONTHLY", 1)).toBe(1_200);
    expect(monthlyEquivalentCents(1_200, "MONTHLY", 3)).toBe(400);
    expect(monthlyEquivalentCents(12_000, "YEARLY", 1)).toBe(1_000);
    expect(monthlyEquivalentCents(1_200, "WEEKLY", 1)).toBe(5_200);
    expect(monthlyEquivalentCents(1_200, "WEEKLY", 2)).toBe(2_600);
  });
});

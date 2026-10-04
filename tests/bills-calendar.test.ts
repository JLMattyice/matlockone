import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Repeating bills on the calendar.
 *
 * What is pinned: a bill shows on each date it comes due across the range
 * looked at, at the latest amount, and stops at its end date; a bill whose
 * amount varies says "about"; a bill recorded shows as paid and is not shown
 * twice; one waiting to be entered shows as waiting; one-off expenses stay
 * off; and who sees any of it is the owner's choice by role — an employee
 * given it sees names and dates, never amounts.
 */

const session = vi.hoisted(() => ({
  user: null as unknown as Record<string, unknown>,
  org: null as unknown as Record<string, unknown>,
}));

vi.mock("@/lib/auth", async () => {
  const { assertCan } = await import("@/lib/permissions");
  return {
    requireContext: async () => session,
    requirePermission: async (permission: string) => {
      assertCan(session.user as never, permission as never);
      return session;
    },
    getContext: async () => session,
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { billsOnCalendar } from "@/app/(app)/schedule/bills";
import { setBillsOnCalendar } from "@/app/(app)/settings/calendar/actions";
import { IDLE } from "@/lib/action-state";
import { parseBillRoles, seesBillsOnCalendar, serializeBillRoles } from "@/lib/bills-calendar";
import { prisma } from "@/lib/db";

const orgs: string[] = [];
let organizationId: string;
let ownerId: string;
let employeeId: string;

/** Noon on a day in November 2026, as the expense dates are kept. */
const nov = (day: number) => new Date(2026, 10, day, 12, 0, 0, 0);
const NOVEMBER = { from: new Date(2026, 10, 1), to: new Date(2026, 10, 30, 23, 59, 59) };

async function person(role: string) {
  const user = await prisma.user.create({
    data: { organizationId, email: `${randomUUID()}@test.local`, name: role, passwordHash: "x", role },
  });
  return user.id;
}

async function as(userId: string) {
  session.user = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })) as unknown as Record<string, unknown>;
  session.org = (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })) as unknown as Record<
    string,
    unknown
  >;
  return session as never;
}

/** A repeating bill: its first expense, and the repeat that copies it. */
async function bill(
  description: string,
  amountCents: number,
  repeat: { frequency: string; nextDate: Date; endDate?: Date; amountVaries?: boolean },
) {
  const schedule = await prisma.expenseSchedule.create({
    data: {
      organizationId,
      frequency: repeat.frequency,
      interval: 1,
      anchorDate: repeat.nextDate,
      nextDate: repeat.nextDate,
      endDate: repeat.endDate ?? null,
      amountVaries: repeat.amountVaries ?? false,
    },
  });
  await prisma.expense.create({
    data: { organizationId, description, amountCents, spentAt: new Date(2026, 9, 1, 12), scheduleId: schedule.id },
  });
  return schedule;
}

const view = async (userId: string) =>
  (await billsOnCalendar(await as(userId), NOVEMBER.from, NOVEMBER.to)).map((b) => ({
    title: b.title,
    day: new Date(b.dateISO).getDate(),
    state: b.state,
    amount: b.amount,
    href: b.href,
  }));

beforeEach(async () => {
  const org = await prisma.organization.create({ data: { slug: `bills-${randomUUID()}`, name: "Bills Co" } });
  orgs.push(org.id);
  organizationId = org.id;
  ownerId = await person("OWNER");
  employeeId = await person("EMPLOYEE");
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

describe("the setting", () => {
  it("reads known roles once each, in rank order", () => {
    expect(parseBillRoles("MANAGER, OWNER,bogus,MANAGER")).toEqual(["OWNER", "MANAGER"]);
    expect(serializeBillRoles(["EMPLOYEE", "ADMIN"])).toBe("ADMIN,EMPLOYEE");
    expect(seesBillsOnCalendar("MANAGER", "OWNER,ADMIN,MANAGER")).toBe(true);
    expect(seesBillsOnCalendar("EMPLOYEE", "OWNER,ADMIN,MANAGER")).toBe(false);
    expect(seesBillsOnCalendar("OWNER", "")).toBe(false);
  });

  it("starts with the roles that can already see expenses, and is the owner's to change", async () => {
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).billsOnCalendarRoles).toBe(
      "OWNER,ADMIN,MANAGER",
    );

    const form = new FormData();
    for (const role of ["OWNER", "EMPLOYEE", "SUPERUSER"]) form.append("roles", role);
    await as(ownerId);
    expect(await setBillsOnCalendar(IDLE, form)).toMatchObject({ ok: true });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).billsOnCalendarRoles).toBe(
      "OWNER,EMPLOYEE",
    );

    await as(employeeId);
    await expect(setBillsOnCalendar(IDLE, new FormData())).rejects.toThrow(/settings:write/);
  });
});

describe("what the calendar shows", () => {
  it("puts a repeating bill on every date it comes due, at the latest amount, until it ends", async () => {
    await bill("Rent", 150_000, { frequency: "MONTHLY", nextDate: nov(5) });
    await bill("Truck wash", 4_000, { frequency: "WEEKLY", nextDate: nov(2), endDate: nov(20) });
    await bill("Next year's insurance", 90_000, { frequency: "YEARLY", nextDate: new Date(2027, 0, 15, 12) });
    // A one-off expense is spending, not a bill due.
    await prisma.expense.create({ data: { organizationId, description: "Lunch", amountCents: 1_500, spentAt: nov(10) } });

    expect(await view(ownerId)).toEqual([
      { title: "Truck wash", day: 2, state: "upcoming", amount: "$40.00", href: expect.stringMatching(/^\/expenses\//) },
      { title: "Rent", day: 5, state: "upcoming", amount: "$1,500.00", href: expect.stringMatching(/^\/expenses\//) },
      { title: "Truck wash", day: 9, state: "upcoming", amount: "$40.00", href: expect.any(String) },
      { title: "Truck wash", day: 16, state: "upcoming", amount: "$40.00", href: expect.any(String) },
    ]);
  });

  it("says “about” for a bill that changes, shows one waiting to be entered, and one paid — not twice", async () => {
    const power = await bill("Electric", 21_240, { frequency: "MONTHLY", nextDate: new Date(2026, 11, 3, 12), amountVaries: true });
    const phone = await bill("Phone", 8_000, { frequency: "MONTHLY", nextDate: new Date(2026, 11, 8, 12) });
    // November's electric came due and is waiting for the real amount.
    const due = nov(3);
    due.setHours(23, 59, 59, 0);
    await prisma.task.create({
      data: { organizationId, title: "Enter Electric for Nov 3", status: "OPEN", dueAt: due, expenseScheduleId: power.id },
    });
    // November's phone bill was recorded on its date.
    await prisma.expense.create({
      data: { organizationId, description: "Phone", amountCents: 8_250, spentAt: nov(8), scheduleId: phone.id },
    });

    expect(await view(ownerId)).toEqual([
      {
        title: "Electric",
        day: 3,
        state: "waiting",
        amount: "about $212.40",
        href: `/expenses/new?repeat=${power.id}&date=2026-11-03`,
      },
      { title: "Phone", day: 8, state: "paid", amount: "$82.50", href: expect.stringMatching(/^\/expenses\//) },
    ]);

    const december = await billsOnCalendar(await as(ownerId), new Date(2026, 11, 1), new Date(2026, 11, 31, 23, 59));
    expect(december.find((b) => b.title === "Electric")).toMatchObject({ state: "upcoming", amount: "about $212.40" });
  });
});

describe("who sees it", () => {
  it("is nobody outside the chosen roles, and an employee given it sees names and dates but no amounts", async () => {
    await bill("Rent", 150_000, { frequency: "MONTHLY", nextDate: nov(5) });

    expect(await view(employeeId)).toEqual([]);

    await prisma.organization.update({ where: { id: organizationId }, data: { billsOnCalendarRoles: "OWNER,EMPLOYEE" } });
    expect(await view(employeeId)).toEqual([{ title: "Rent", day: 5, state: "upcoming", amount: null, href: null }]);

    const manager = await person("MANAGER");
    expect(await view(manager)).toEqual([]);

    await prisma.organization.update({ where: { id: organizationId }, data: { billsOnCalendarRoles: "" } });
    expect(await view(ownerId)).toEqual([]);
  });
});

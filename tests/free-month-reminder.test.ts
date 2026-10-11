import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  freeMonthReminderEmail,
  REMINDER_ACTION,
  remindFreeMonths,
} from "@/lib/billing/free-month-reminder";
import type { SystemMailer } from "@/lib/checkout/deliver";
import { prisma } from "@/lib/db";

/**
 * The email before a free month from a code runs out.
 *
 * What matters: the owner of a business about to lock hears about it once, a
 * few days ahead; nobody hears about it twice; and a business that has a plan
 * lined up, or is not billed at all, hears nothing.
 *
 * The clock is pinned years ahead, so businesses other test files leave in
 * the shared database never fall inside the reminder's window.
 */

const NOW = new Date("2031-01-01T11:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const fromNow = (days: number) => new Date(NOW.getTime() + days * DAY);

const MAILER: SystemMailer = {
  provider: "SMTP",
  config: { fromName: "Matlock One", fromEmail: "hello@matlockone.test", host: "smtp.test", port: 587, secure: false, username: "hello@matlockone.test" },
  secret: "x",
};

let sent: { to: string; subject: string; text: string }[];
let refuse: Set<string>;

const send = vi.fn(async (_provider: unknown, _config: unknown, _secret: unknown, email: { to: string; subject: string; text: string }) => {
  if (refuse.has(email.to)) return { ok: false as const, error: "The mail provider refused the message." };
  sent.push({ to: email.to, subject: email.subject, text: email.text });
  return { ok: true as const };
});

const run = (now = NOW) => remindFreeMonths({ mailer: MAILER, send, now });

/** A business on a free month, with an owner, an admin and an employee. */
async function onFreeMonth(endsIn: number, fields: Record<string, unknown> = {}) {
  const ends = fromNow(endsIn);
  const org = await prisma.organization.create({
    data: {
      slug: `free-${randomUUID()}`,
      name: "Cedar Street Bakery",
      subscriptionPlan: "business",
      paidThrough: ends,
      trialEndsAt: ends,
      ...fields,
    },
  });
  const person = (role: string, isActive = true) =>
    prisma.user.create({
      data: {
        organizationId: org.id,
        email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
        name: role === "OWNER" ? "Rosa Delgado" : "Sam Okafor",
        passwordHash: "x",
        role,
        isActive,
      },
    });
  const owner = await person("OWNER");
  const admin = await person("ADMIN");
  const employee = await person("EMPLOYEE");
  return { org, owner, admin, employee };
}

const toldRows = (organizationId: string) =>
  prisma.auditLog.count({ where: { organizationId, action: REMINDER_ACTION } });
const to = (email: string) => sent.filter((mail) => mail.to === email);

beforeEach(() => {
  sent = [];
  refuse = new Set();
  send.mockClear();
});

describe("who is reminded", () => {
  it("emails the owner of a business whose free month ends in a few days", async () => {
    const { org, owner, admin, employee } = await onFreeMonth(2);

    await run();

    expect(to(owner.email)).toHaveLength(1);
    expect(to(admin.email)).toHaveLength(0);
    expect(to(employee.email)).toHaveLength(0);
    expect(await toldRows(org.id)).toBe(1);
  });

  it("emails the admins when the business has no active owner", async () => {
    const { owner, admin } = await onFreeMonth(1);
    await prisma.user.update({ where: { id: owner.id }, data: { isActive: false } });

    await run();

    expect(to(owner.email)).toHaveLength(0);
    expect(to(admin.email)).toHaveLength(1);
  });

  it("does not email the same business twice", async () => {
    const { org, owner } = await onFreeMonth(3);

    await run();
    await run(fromNow(1));

    expect(to(owner.email)).toHaveLength(1);
    expect(await toldRows(org.id)).toBe(1);
  });

  it("waits until the month is nearly over, and stops once it is", async () => {
    const early = await onFreeMonth(10);
    const over = await onFreeMonth(-1);

    await run();

    expect(to(early.owner.email)).toHaveLength(0);
    expect(to(over.owner.email)).toHaveLength(0);
  });

  it("leaves alone a business that has lined up a plan, or is never billed", async () => {
    const lined = await onFreeMonth(2, { subscriptionId: `I-${randomUUID()}`, subscriptionStatus: "APPROVED" });
    const exempt = await onFreeMonth(2, { billingExempt: true });
    const demo = await onFreeMonth(2, { isDemo: true });

    await run();

    expect(to(lined.owner.email)).toHaveLength(0);
    expect(to(exempt.owner.email)).toHaveLength(0);
    expect(to(demo.owner.email)).toHaveLength(0);
  });
});

describe("when it cannot send", () => {
  it("records nothing for a business none of whose emails went out, and tries again next morning", async () => {
    const { org, owner } = await onFreeMonth(2);
    refuse.add(owner.email);

    const first = await run();
    expect(first.failed).toBeGreaterThanOrEqual(1);
    expect(await toldRows(org.id)).toBe(0);

    refuse.clear();
    await run(fromNow(1));
    expect(to(owner.email)).toHaveLength(1);
    expect(await toldRows(org.id)).toBe(1);
  });

  it("sends and records nothing without a mailbox", async () => {
    const { org } = await onFreeMonth(2);

    expect(await remindFreeMonths({ mailer: null, send, now: NOW })).toMatchObject({ notConfigured: true });
    expect(send).not.toHaveBeenCalled();
    expect(await toldRows(org.id)).toBe(0);
  });
});

describe("what it says", () => {
  it("names the day on the business's own clock, and where to choose a plan", async () => {
    // 3 am in London on the 3rd is still the evening of the 2nd in Los Angeles.
    const { owner } = await onFreeMonth(2, {
      trialEndsAt: new Date("2031-01-03T03:00:00Z"),
      paidThrough: new Date("2031-01-03T03:00:00Z"),
      timeZone: "America/Los_Angeles",
    });

    await run();

    const [mail] = to(owner.email);
    expect(mail.subject).toBe("Your free month of Matlock One ends Thursday, January 2");
    expect(mail.text).toContain("Hello Rosa Delgado,");
    expect(mail.text).toContain("The free month for Cedar Street Bakery on Matlock One ends on Thursday, January 2.");
    expect(mail.text).toMatch(/https?:\/\/\S+\/billing/);
  });

  it("says nothing is charged before the end and nothing is deleted after it", () => {
    const email = freeMonthReminderEmail({
      to: "rosa@example.test",
      name: "Rosa",
      businessName: "Cedar Street Bakery",
      endsOn: "Monday, November 10",
      billingUrl: "https://www.matlockone.com/billing",
    });

    expect(email.text).toContain("Nothing is charged until the free month is over.");
    expect(email.text).toContain("Cedar Street Bakery locks when the free month ends.");
    expect(email.text).toContain("Nothing is deleted");
    expect(email.text).toContain("https://www.matlockone.com/billing");
  });
});

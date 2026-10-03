import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { sweep, workflowSettings } from "@/lib/workflows/run";
import { WORKFLOW_TEMPLATES } from "@/lib/workflows/templates";

/**
 * The automations that email a customer.
 *
 * These write to somebody's customers, so what is pinned is restraint as much
 * as delivery: all of them start off; each sends once per thing however often
 * the sweep runs; switching one on catches up on two weeks at most, not every
 * old record; nobody without an email address is written to; the review
 * request waits for a review link and asks each customer once.
 */

const DAY = 24 * 60 * 60 * 1000;
const orgs: string[] = [];
let organizationId: string;
let clientId: string;

beforeEach(async () => {
  const org = await prisma.organization.create({
    data: { slug: `mail-${randomUUID()}`, name: "Mail Test Co", timeZone: "UTC", phone: "8655550142" },
  });
  orgs.push(org.id);
  organizationId = org.id;
  const client = await prisma.client.create({
    data: { organizationId, displayName: "Jane Doe", email: "jane@example.com", type: "PERSON" },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

async function enable(templateId: string, days?: number) {
  await prisma.workflow.create({
    data: {
      organizationId,
      templateId,
      isActive: true,
      config: days === undefined ? null : JSON.stringify({ days }),
    },
  });
}

const outbox = () =>
  prisma.outboxMessage.findMany({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
    select: { toAddress: true, subject: true, body: true },
  });

const ago = (days: number) => new Date(Date.now() - days * DAY);

describe("the customer email automations", () => {
  it("all start off", async () => {
    const emailing = (await workflowSettings(organizationId)).filter((row) => row.template.action === "EMAIL");
    expect(emailing.map((row) => row.template.id).sort()).toEqual([
      "appointment.reminder.email",
      "estimate.followup.email",
      "invoice.due-soon.email",
      "invoice.overdue.email",
      "review.request.email",
    ]);
    expect(emailing.every((row) => !row.isActive)).toBe(true);
    expect(WORKFLOW_TEMPLATES.filter((t) => t.action === "TASK")).toHaveLength(4);
  });
});

describe("following up an estimate", () => {
  it("emails once, with the link, when it has gone unanswered — and leaves answered, expired and ancient ones alone", async () => {
    const make = (number: string, sentAt: Date, extra: Record<string, unknown> = {}) =>
      prisma.estimate.create({
        data: { organizationId, clientId, number, status: "SENT", sentAt, totalCents: 50_000, ...extra },
      });
    const due = await make("EST-1", ago(4));
    await make("EST-2", ago(1)); // too soon
    await make("EST-3", ago(5), { status: "ACCEPTED" });
    await make("EST-4", ago(5), { expiresAt: ago(1) });
    await make("EST-5", ago(60)); // before the catch-up window
    await enable("estimate.followup.email", 3);

    await sweep(organizationId);
    await sweep(organizationId);

    const sent = await outbox();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ toAddress: "jane@example.com", subject: "Following up on estimate EST-1 from Mail Test Co" });
    expect(sent[0].body).toContain("Just checking in on estimate EST-1 for $500.00.");
    expect(sent[0].body).toContain(`/share/estimate/${due.publicToken}`);
    expect(sent[0].body).toContain("reach us on (865) 555-0142");
    expect(sent[0].body).toMatch(/Everything with us in one place: \S+\/portal\//);
  });
});

describe("invoice reminders", () => {
  const invoice = (number: string, dueDate: Date, extra: Record<string, unknown> = {}) =>
    prisma.invoice.create({
      data: { organizationId, clientId, number, status: "SENT", dueDate, totalCents: 20_000, balanceCents: 20_000, ...extra },
    });

  it("reminds before the due date, once", async () => {
    await invoice("INV-1", new Date(Date.now() + 2 * DAY));
    await invoice("INV-2", new Date(Date.now() + 10 * DAY)); // not yet
    await invoice("INV-3", new Date(Date.now() + 2 * DAY), { balanceCents: 0, status: "PAID" });
    await enable("invoice.due-soon.email", 3);

    await sweep(organizationId);
    await sweep(organizationId);
    expect((await outbox()).map((m) => m.subject)).toEqual([expect.stringMatching(/^Reminder: invoice INV-1 is due /)]);
  });

  it("chases once it is overdue — without raising a task, and leaving the task chase to its own switch", async () => {
    await invoice("INV-1", ago(8));
    await invoice("INV-2", ago(200)); // long before the window
    await invoice("INV-3", ago(8), { status: "DRAFT" });
    await enable("invoice.overdue.email", 7);

    await sweep(organizationId);
    const sent = await outbox();
    expect(sent.map((m) => m.subject)).toEqual(["Invoice INV-1 is past due"]);
    expect(sent[0].body).toContain("If you've already paid, thank you — please ignore this.");
    expect(await prisma.task.count({ where: { organizationId } })).toBe(0);
  });

  it("writes to nobody without an email address, and still can once one is added", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { email: null } });
    await invoice("INV-1", ago(8));
    await enable("invoice.overdue.email", 7);

    await sweep(organizationId);
    expect(await outbox()).toHaveLength(0);

    await prisma.client.update({ where: { id: clientId }, data: { email: "jane@example.com" } });
    await sweep(organizationId);
    expect(await outbox()).toHaveLength(1);
  });
});

describe("appointment reminders", () => {
  it("reminds the day before, and again if the visit is moved to another day", async () => {
    const tomorrowNoon = new Date(Date.now() + DAY);
    tomorrowNoon.setUTCHours(12, 0, 0, 0);
    const job = await prisma.job.create({
      data: { organizationId, clientId, number: "J-1", title: "Spring clean-up", status: "SCHEDULED", scheduledStart: tomorrowNoon },
    });
    await enable("appointment.reminder.email", 1);

    await sweep(organizationId);
    await sweep(organizationId);
    const [first] = await outbox();
    expect(first.subject).toMatch(/^Reminder: Mail Test Co is booked for /);
    expect(first.body).toContain("we're booked for Spring clean-up on");
    expect(first.body).toContain("at 12:00 PM");

    // Moved to the day after: tomorrow's sweep would remind again. Here the
    // reminder window is widened to two days to find it today.
    await prisma.job.update({ where: { id: job.id }, data: { scheduledStart: new Date(tomorrowNoon.getTime() + DAY) } });
    await prisma.workflow.updateMany({ where: { organizationId }, data: { config: JSON.stringify({ days: 2 }) } });
    await sweep(organizationId);
    expect(await outbox()).toHaveLength(2);
  });
});

describe("asking for a review", () => {
  it("waits for a review link, then asks each customer once, however much work they have done", async () => {
    await prisma.job.createMany({
      data: [
        { organizationId, clientId, number: "J-1", title: "Lawn", status: "COMPLETED", completedAt: ago(3) },
        { organizationId, clientId, number: "J-2", title: "Lawn again", status: "COMPLETED", completedAt: ago(4) },
      ],
    });
    await enable("review.request.email", 2);

    await sweep(organizationId);
    expect(await outbox()).toHaveLength(0);

    await prisma.organization.update({
      where: { id: organizationId },
      data: { reviewUrl: "https://g.page/r/example/review" },
    });
    await sweep(organizationId);
    await sweep(organizationId);

    const sent = await outbox();
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("a review would mean a lot to a small business like ours: https://g.page/r/example/review");
  });
});

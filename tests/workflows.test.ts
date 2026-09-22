import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import {
  runEventWorkflows,
  sweep,
  workflowSettings,
} from "@/lib/workflows/run";
import {
  resolveConfig,
  taskTitleFor,
  templateById,
  WORKFLOW_TEMPLATES,
} from "@/lib/workflows/templates";

/**
 * Automations.
 *
 * The feature lives or dies on firing exactly once per thing. An automation
 * that raises the same task every time a sweep runs teaches people to ignore
 * the tasks it makes, which is worse than not having it.
 */

let organizationId: string;
let otherOrganizationId: string;
let clientId: string;

const daysAgo = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
};

async function seedOrg(name: string) {
  const org = await prisma.organization.create({
    data: { slug: `wf-${randomUUID()}`, name },
  });
  return org.id;
}

async function enable(templateId: string, config?: Record<string, number>, orgId?: string) {
  return prisma.workflow.create({
    data: {
      organizationId: orgId ?? organizationId,
      templateId,
      isActive: true,
      config: config ? JSON.stringify(config) : null,
    },
  });
}

async function addInvoice(overrides: { dueDate?: Date; balanceCents?: number; status?: string } = {}) {
  return prisma.invoice.create({
    data: {
      organizationId,
      clientId,
      number: `INV-${Math.floor(Math.random() * 100_000)}`,
      status: overrides.status ?? "SENT",
      issueDate: daysAgo(30),
      dueDate: overrides.dueDate ?? daysAgo(14),
      subtotalCents: 50_000,
      totalCents: 50_000,
      balanceCents: overrides.balanceCents ?? 50_000,
    },
  });
}

const tasks = () =>
  prisma.task.findMany({ where: { organizationId }, select: { title: true, dueAt: true } });

beforeEach(async () => {
  organizationId = await seedOrg("Workflow Test Co");
  otherOrganizationId = await seedOrg("Someone Else Ltd");

  const client = await prisma.client.create({
    data: {
      organizationId,
      displayName: "Oscar Nakamura",
      type: "PERSON",
      status: "ACTIVE",
      createdAt: daysAgo(400),
    },
  });
  clientId = client.id;
});

describe("the catalog", () => {
  it("gives every automation a sentence and a task to raise", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      expect(template.name, template.id).toBeTruthy();
      expect(template.description, template.id).toBeTruthy();
      expect(template.taskTitle, template.id).toContain("{subject}");
      expect(template.defaults.dueInDays, template.id).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps ids unique, since one is stored per organization", () => {
    const ids = WORKFLOW_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveConfig", () => {
  const chase = templateById("overdue.chase")!;

  it("falls back to the defaults when nothing is stored", () => {
    expect(resolveConfig(chase, null)).toEqual({ days: 7, dueInDays: 1 });
  });

  it("survives nonsense rather than refusing to run", () => {
    // An automation that stops because a stored number was odd is worse than
    // one that runs with the number it shipped with.
    expect(resolveConfig(chase, "not json")).toEqual({ days: 7, dueInDays: 1 });
    expect(resolveConfig(chase, JSON.stringify({ days: "soon" }))).toEqual({
      days: 7,
      dueInDays: 1,
    });
  });

  it("clamps a number into the range the template allows", () => {
    // A hand-edited form must not set a chase to fire nine thousand days late.
    expect(resolveConfig(chase, JSON.stringify({ days: 9000, dueInDays: -5 }))).toEqual(
      { days: 120, dueInDays: 0 },
    );
  });
});

describe("taskTitleFor", () => {
  it("fills in who and what", () => {
    const chase = templateById("overdue.chase")!;

    expect(
      taskTitleFor(chase, { subject: "Oscar Nakamura", document: "INV-1042" }),
    ).toBe("Chase Oscar Nakamura about INV-1042");
  });
});

describe("an event automation", () => {
  it("raises a task when an invoice is settled", async () => {
    await enable("paid.thank");
    const invoice = await addInvoice({ balanceCents: 0, status: "PAID" });

    await runEventWorkflows("invoice.paid", {
      organizationId,
      entityType: "INVOICE",
      entityId: invoice.id,
      subject: "Oscar Nakamura",
      document: invoice.number,
      clientId,
    });

    const raised = await tasks();
    expect(raised.map((task) => task.title)).toEqual([
      `Thank Oscar Nakamura for paying ${invoice.number}`,
    ]);
  });

  it("does nothing at all when it is switched off", async () => {
    const workflow = await enable("paid.thank");
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { isActive: false },
    });

    const invoice = await addInvoice();
    await runEventWorkflows("invoice.paid", {
      organizationId,
      entityType: "INVOICE",
      entityId: invoice.id,
      subject: "Oscar Nakamura",
      document: invoice.number,
      clientId,
    });

    expect(await tasks()).toHaveLength(0);
  });

  it("fires once for one invoice, however many times it is called", async () => {
    await enable("paid.thank");
    const invoice = await addInvoice();

    const event = {
      organizationId,
      entityType: "INVOICE" as const,
      entityId: invoice.id,
      subject: "Oscar Nakamura",
      document: invoice.number,
      clientId,
    };

    await runEventWorkflows("invoice.paid", event);
    await runEventWorkflows("invoice.paid", event);
    await runEventWorkflows("invoice.paid", event);

    expect(await tasks()).toHaveLength(1);
  });

  it("never fires another business's automations", async () => {
    await enable("paid.thank", undefined, otherOrganizationId);
    const invoice = await addInvoice();

    await runEventWorkflows("invoice.paid", {
      organizationId,
      entityType: "INVOICE",
      entityId: invoice.id,
      subject: "Oscar Nakamura",
      document: invoice.number,
      clientId,
    });

    expect(await tasks()).toHaveLength(0);
  });
});

describe("the sweep", () => {
  it("raises a task for an invoice past the day count", async () => {
    await enable("overdue.chase", { days: 7, dueInDays: 1 });
    const invoice = await addInvoice({ dueDate: daysAgo(14) });

    const outcomes = await sweep(organizationId);

    expect(outcomes.find((o) => o.templateId === "overdue.chase")?.created).toEqual([
      `Chase Oscar Nakamura about ${invoice.number}`,
    ]);
  });

  it("leaves an invoice that is late but not late enough", async () => {
    await enable("overdue.chase", { days: 30, dueInDays: 1 });
    await addInvoice({ dueDate: daysAgo(14) });

    const outcomes = await sweep(organizationId);
    expect(outcomes.find((o) => o.templateId === "overdue.chase")?.created).toEqual([]);
  });

  it("ignores what is not owed: drafts, cancellations and settled invoices", async () => {
    await enable("overdue.chase", { days: 7, dueInDays: 1 });

    await addInvoice({ dueDate: daysAgo(60), status: "DRAFT" });
    await addInvoice({ dueDate: daysAgo(60), status: "CANCELLED" });
    await addInvoice({ dueDate: daysAgo(60), status: "PAID", balanceCents: 0 });

    const outcomes = await sweep(organizationId);
    expect(outcomes.find((o) => o.templateId === "overdue.chase")?.created).toEqual([]);
  });

  it("raises one task per invoice however often it is run", async () => {
    // The button says it is safe to press repeatedly. This is that promise.
    await enable("overdue.chase", { days: 7, dueInDays: 1 });
    await addInvoice({ dueDate: daysAgo(14) });

    await sweep(organizationId);
    await sweep(organizationId);
    const third = await sweep(organizationId);

    expect(await tasks()).toHaveLength(1);
    expect(third.find((o) => o.templateId === "overdue.chase")?.created).toEqual([]);
  });

  it("gives the task a due date the automation chose", async () => {
    await enable("overdue.chase", { days: 7, dueInDays: 3 });
    await addInvoice({ dueDate: daysAgo(14) });

    await sweep(organizationId);

    const [task] = await tasks();
    const days = Math.round(
      (task.dueAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );
    expect(days).toBe(3);
  });

  it("notices a customer who has gone quiet", async () => {
    await enable("idle.followup", { days: 90, dueInDays: 3 });

    const outcomes = await sweep(organizationId);
    const created = outcomes.find((o) => o.templateId === "idle.followup")?.created;

    expect(created?.[0]).toContain("Check in with Oscar Nakamura");
  });

  it("leaves alone a customer something happened with recently", async () => {
    await enable("idle.followup", { days: 90, dueInDays: 3 });
    await prisma.job.create({
      data: { organizationId, clientId, number: "JOB-1", title: "Panel upgrade" },
    });

    const outcomes = await sweep(organizationId);
    expect(outcomes.find((o) => o.templateId === "idle.followup")?.created).toEqual([]);
  });

  it("records when it last looked", async () => {
    const workflow = await enable("overdue.chase");
    expect(workflow.lastRunAt).toBeNull();

    await sweep(organizationId);

    const after = await prisma.workflow.findUniqueOrThrow({
      where: { id: workflow.id },
    });
    expect(after.lastRunAt).not.toBeNull();
  });

  it("does nothing for a business with no automations on", async () => {
    await addInvoice({ dueDate: daysAgo(90) });

    expect(await sweep(organizationId)).toEqual([]);
    expect(await tasks()).toHaveLength(0);
  });
});

describe("workflowSettings", () => {
  it("lists every automation, on or off", async () => {
    await enable("overdue.chase", { days: 21, dueInDays: 2 });

    const rows = await workflowSettings(organizationId);

    expect(rows).toHaveLength(WORKFLOW_TEMPLATES.length);

    const chase = rows.find((row) => row.template.id === "overdue.chase")!;
    expect(chase.isActive).toBe(true);
    expect(chase.config).toEqual({ days: 21, dueInDays: 2 });
    expect(chase.scheduled).toBe(true);

    const thank = rows.find((row) => row.template.id === "paid.thank")!;
    expect(thank.isActive).toBe(false);
    // Off, and still showing what it would do if turned on.
    expect(thank.config.dueInDays).toBe(2);
    expect(thank.scheduled).toBe(false);
  });
});

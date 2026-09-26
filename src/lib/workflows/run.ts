import "server-only";

import { prisma } from "../db";
import {
  isScheduled,
  resolveConfig,
  taskTitleFor,
  templateById,
  WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
  type WorkflowTrigger,
} from "./templates";

/**
 * Running the automations.
 *
 * Two ways in, because the product has no scheduler and will not pretend to:
 *
 * **Events** fire inside the action that caused them — an invoice settled, an
 * estimate accepted. Those are genuinely automatic.
 *
 * **Time** has to be swept for. Nothing wakes up on its own: the hosted
 * deployment is serverless functions that exist only while answering a
 * request, and the desktop one is somebody's PC that is off at the weekend. So
 * "an invoice is seven days overdue" is found by `sweep()`, which the
 * automations screen runs on demand and which a scheduler could call later
 * without changing a line here.
 *
 * Every automation makes a task, and every one records what it fired for so it
 * cannot fire for that thing twice.
 */

export type WorkflowOutcome = {
  templateId: string;
  /** The task titles raised, for showing back to whoever pressed Run. */
  created: string[];
};

type TaskSpec = {
  title: string;
  dueInDays: number;
  clientId?: string | null;
  jobId?: string | null;
};

/**
 * Raises the task, unless this automation has already fired for this thing.
 *
 * The uniqueness lives in the database rather than in a check-then-write here:
 * two sweeps running at once would both pass the check and both write. The
 * insert is attempted first and a duplicate is taken as "already done".
 */
async function fire(
  workflow: { id: string; organizationId: string },
  entity: { type: string; id: string },
  task: TaskSpec,
): Promise<string | null> {
  try {
    await prisma.workflowRun.create({
      data: {
        workflowId: workflow.id,
        organizationId: workflow.organizationId,
        entityType: entity.type,
        entityId: entity.id,
        summary: task.title,
      },
    });
  } catch {
    // The unique index refused it: this automation has already handled this
    // invoice or customer, which is exactly the point.
    return null;
  }

  const dueAt = new Date();
  dueAt.setDate(dueAt.getDate() + task.dueInDays);
  dueAt.setHours(23, 59, 59, 0);

  await prisma.task.create({
    data: {
      organizationId: workflow.organizationId,
      title: task.title,
      status: "OPEN",
      dueAt,
      clientId: task.clientId ?? null,
      jobId: task.jobId ?? null,
      // No assignee: an automation does not know whose job this is, and
      // guessing wrong is how a list becomes somebody else's problem.
    },
  });

  return task.title;
}

async function activeWorkflows(organizationId: string, trigger: WorkflowTrigger) {
  const rows = await prisma.workflow.findMany({
    where: { organizationId, isActive: true },
  });

  return rows
    .map((row) => ({ row, template: templateById(row.templateId) }))
    .filter(
      (pair): pair is { row: (typeof rows)[number]; template: WorkflowTemplate } =>
        pair.template !== null && pair.template.trigger === trigger,
    );
}

// ------------------------------------------------------------------ events ---

export type EventContext = {
  organizationId: string;
  /** What happened to, for recording that it fired. */
  entityType: "INVOICE" | "ESTIMATE";
  entityId: string;
  /** Who it concerns, and what the document is called. */
  subject: string;
  document: string;
  clientId?: string | null;
  jobId?: string | null;
};

/**
 * Runs whatever is turned on for one event.
 *
 * Swallows its own failures. An invoice that was paid, recorded and receipted
 * must not report an error because an automation could not raise a task about
 * it — the payment is the business's money, the task is a convenience.
 */
export async function runEventWorkflows(
  trigger: Extract<WorkflowTrigger, "invoice.paid" | "estimate.accepted">,
  context: EventContext,
): Promise<void> {
  try {
    const workflows = await activeWorkflows(context.organizationId, trigger);

    for (const { row, template } of workflows) {
      const config = resolveConfig(template, row.config);

      await fire(
        row,
        { type: context.entityType, id: context.entityId },
        {
          title: taskTitleFor(template, {
            subject: context.subject,
            document: context.document,
          }),
          dueInDays: config.dueInDays,
          clientId: context.clientId,
          jobId: context.jobId,
        },
      );
    }
  } catch {
    // Deliberately quiet, for the reason above.
  }
}

// ------------------------------------------------------------------- sweep ---

/**
 * Looks for the things that became true while nobody was watching.
 *
 * Returns what it did, because the screen that runs it should say so rather
 * than claiming success into the void.
 */
export async function sweep(organizationId: string): Promise<WorkflowOutcome[]> {
  const outcomes: WorkflowOutcome[] = [];

  for (const template of WORKFLOW_TEMPLATES.filter(isScheduled)) {
    const [row] = await prisma.workflow.findMany({
      where: { organizationId, templateId: template.id, isActive: true },
      take: 1,
    });
    if (!row) continue;

    const config = resolveConfig(template, row.config);
    const created: string[] = [];

    if (template.trigger === "invoice.overdue") {
      created.push(...(await sweepOverdueInvoices(row, template, config.days, config.dueInDays)));
    }

    if (template.trigger === "client.idle") {
      created.push(...(await sweepIdleClients(row, template, config.days, config.dueInDays)));
    }

    await prisma.workflow.update({
      where: { id: row.id },
      data: { lastRunAt: new Date() },
    });

    outcomes.push({ templateId: template.id, created });
  }

  return outcomes;
}

async function sweepOverdueInvoices(
  workflow: { id: string; organizationId: string },
  template: WorkflowTemplate,
  days: number,
  dueInDays: number,
): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId: workflow.organizationId,
      // Drafts were never issued and cancelled ones are not owed. Anything
      // with a balance and a due date far enough in the past is fair game.
      status: { notIn: ["DRAFT", "CANCELLED", "PAID"] },
      balanceCents: { gt: 0 },
      dueDate: { lt: cutoff },
    },
    select: {
      id: true,
      number: true,
      clientId: true,
      client: { select: { displayName: true } },
    },
    take: 100,
  });

  const created: string[] = [];

  for (const invoice of invoices) {
    const title = await fire(
      workflow,
      { type: "INVOICE", id: invoice.id },
      {
        title: taskTitleFor(template, {
          subject: invoice.client?.displayName ?? "the customer",
          document: invoice.number,
        }),
        dueInDays,
        clientId: invoice.clientId,
      },
    );
    if (title) created.push(title);
  }

  return created;
}

async function sweepIdleClients(
  workflow: { id: string; organizationId: string },
  template: WorkflowTemplate,
  days: number,
  dueInDays: number,
): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  // "Nothing has happened" means nothing anybody would call contact: no work,
  // no document, no money. A customer whose only record is the day they were
  // added counts as quiet since that day.
  const clients = await prisma.client.findMany({
    where: {
      organizationId: workflow.organizationId,
      status: "ACTIVE",
      createdAt: { lt: cutoff },
      jobs: { none: { createdAt: { gte: cutoff } } },
      invoices: { none: { createdAt: { gte: cutoff } } },
      estimates: { none: { createdAt: { gte: cutoff } } },
      payments: { none: { receivedAt: { gte: cutoff } } },
    },
    select: { id: true, displayName: true, createdAt: true },
    take: 100,
  });

  const created: string[] = [];

  for (const client of clients) {
    const title = await fire(
      workflow,
      { type: "CLIENT", id: client.id },
      {
        title: taskTitleFor(template, {
          subject: client.displayName,
          document: client.createdAt.toLocaleDateString(),
        }),
        dueInDays,
        clientId: client.id,
      },
    );
    if (title) created.push(title);
  }

  return created;
}

/**
 * The sweep for every business that has something to sweep for — what the
 * morning schedule runs.
 *
 * Businesses are taken one at a time and each is its own attempt. One whose
 * sweep fails is named in the result and logged, and the rest still get
 * theirs: a single bad record in one business must not mean nobody's overdue
 * invoices are chased that day.
 */
export async function sweepEveryBusiness(): Promise<{
  businesses: number;
  created: number;
  failed: string[];
}> {
  const scheduled = WORKFLOW_TEMPLATES.filter(isScheduled).map((template) => template.id);

  const rows = await prisma.workflow.findMany({
    // Not the demo: a morning of chase tasks would pile up in a business that
    // is meant to look the same to every visitor.
    where: { isActive: true, templateId: { in: scheduled }, organization: { isDemo: false } },
    select: { organizationId: true },
    distinct: ["organizationId"],
  });

  let created = 0;
  const failed: string[] = [];

  for (const { organizationId } of rows) {
    try {
      const outcomes = await sweep(organizationId);
      created += outcomes.reduce((total, outcome) => total + outcome.created.length, 0);
    } catch (error) {
      failed.push(organizationId);
      console.error(`[automations] the sweep failed for organization ${organizationId}`, error);
    }
  }

  return { businesses: rows.length, created, failed };
}

// ------------------------------------------------------------------ screen ---

/** Every automation with whether this business has turned it on. */
export async function workflowSettings(organizationId: string) {
  const rows = await prisma.workflow.findMany({ where: { organizationId } });
  const byTemplate = new Map(rows.map((row) => [row.templateId, row]));

  return WORKFLOW_TEMPLATES.map((template) => {
    const row = byTemplate.get(template.id);

    return {
      template,
      isActive: row?.isActive ?? false,
      config: resolveConfig(template, row?.config),
      lastRunAt: row?.lastRunAt ?? null,
      scheduled: isScheduled(template),
    };
  });
}

/** How many tasks the automations have raised, for the screen's own summary. */
export async function workflowRunCount(organizationId: string): Promise<number> {
  return prisma.workflowRun.count({ where: { organizationId } });
}

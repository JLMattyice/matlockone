"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { record } from "@/lib/activity";
import { prisma } from "@/lib/db";
import { can, taskVisibilityWhere } from "@/lib/permissions";

/**
 * Writes for tasks.
 *
 * Every one re-reads the task under the caller's own visibility rule before
 * touching it. A technician who can see their list must not be able to close
 * somebody else's task by posting its id.
 */

const taskSchema = z.object({
  title: z.string().trim().min(1, "What needs doing?").max(200, "Keep it short."),
  notes: z.string().trim().nullish(),
  dueAt: z.string().trim().nullish(),
  assignedToId: z.string().trim().nullish(),
  clientId: z.string().trim().nullish(),
  jobId: z.string().trim().nullish(),
  leadId: z.string().trim().nullish(),
});

/**
 * A date input gives a bare "2026-09-21", which `new Date` reads as UTC
 * midnight and can render as the day before west of Greenwich. Built from the
 * parts, at the end of that day: a task due Friday is not late on Friday
 * morning.
 */
function parseDue(value: string | null | undefined): Date | null {
  if (!value) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    23,
    59,
    59,
  );
}

/**
 * Every id on the form belongs to somebody, and the form is public input.
 * Anything that does not belong to this organization is dropped rather than
 * refused: the task is still worth creating without the link.
 */
async function resolveLinks(
  input: z.infer<typeof taskSchema>,
  organizationId: string,
) {
  const [assignee, client, job, lead] = await Promise.all([
    input.assignedToId
      ? prisma.user.findFirst({
          where: { id: input.assignedToId, organizationId, isActive: true },
          select: { id: true },
        })
      : null,
    input.clientId
      ? prisma.client.findFirst({
          where: { id: input.clientId, organizationId },
          select: { id: true },
        })
      : null,
    input.jobId
      ? prisma.job.findFirst({
          where: { id: input.jobId, organizationId },
          select: { id: true, clientId: true },
        })
      : null,
    input.leadId
      ? prisma.lead.findFirst({
          where: { id: input.leadId, organizationId },
          select: { id: true },
        })
      : null,
  ]);

  return {
    assignedToId: assignee?.id ?? null,
    // A job already knows whose it is, so a task on a job belongs to that
    // job's client rather than to whatever the form said.
    clientId: job ? job.clientId : (client?.id ?? null),
    jobId: job?.id ?? null,
    leadId: lead?.id ?? null,
  };
}

function parseTaskForm(formData: FormData) {
  return taskSchema.safeParse({
    title: formData.get("title"),
    notes: text(formData, "notes"),
    dueAt: text(formData, "dueAt"),
    assignedToId: text(formData, "assignedToId"),
    clientId: text(formData, "clientId"),
    jobId: text(formData, "jobId"),
    leadId: text(formData, "leadId"),
  });
}

export async function createTask(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("tasks:write");

  const parsed = parseTaskForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const links = await resolveLinks(parsed.data, org.id);

  await prisma.task.create({
    data: {
      organizationId: org.id,
      title: parsed.data.title,
      notes: parsed.data.notes || null,
      dueAt: parseDue(parsed.data.dueAt),
      createdById: user.id,
      ...links,
    },
  });

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  if (links.jobId) revalidatePath(`/jobs/${links.jobId}`);
  if (links.clientId) revalidatePath(`/clients/${links.clientId}`);

  return saved("Added.");
}

/**
 * Ticks a task off, or puts it back.
 *
 * One action for both directions because the list is a row of checkboxes: the
 * form carries where it is going rather than the caller guessing from state
 * that may have moved since the page rendered.
 */
export async function setTaskDone(formData: FormData) {
  const { user, org } = await requirePermission("tasks:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const done = String(formData.get("done") ?? "") === "true";

  const task = await prisma.task.findFirst({
    where: { id, organizationId: org.id, ...taskVisibilityWhere(user) },
    select: { id: true, title: true, status: true, jobId: true, clientId: true },
  });
  if (!task) return;

  await prisma.task.update({
    where: { id },
    data: {
      status: done ? "DONE" : "OPEN",
      completedAt: done ? new Date() : null,
      completedById: done ? user.id : null,
    },
  });

  // Only the finishing is news. Re-opening one is a correction, and a timeline
  // that records both reads like an argument with itself.
  if (done && task.status !== "DONE") {
    await record({
      organizationId: org.id,
      userId: user.id,
      action: "task.completed",
      entityType: task.jobId ? "JOB" : "CLIENT",
      entityId: task.jobId ?? task.clientId ?? task.id,
      summary: `Task done — ${task.title}`,
    });
  }

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  if (task.jobId) revalidatePath(`/jobs/${task.jobId}`);
  if (task.clientId) revalidatePath(`/clients/${task.clientId}`);
}

export async function updateTask(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("tasks:write");

  const id = text(formData, "id");
  if (!id) return failed("Missing task id.");

  const existing = await prisma.task.findFirst({
    where: { id, organizationId: org.id, ...taskVisibilityWhere(user) },
    select: { id: true },
  });
  if (!existing) return failed("That task no longer exists.");

  const parsed = parseTaskForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const links = await resolveLinks(parsed.data, org.id);

  await prisma.task.update({
    where: { id },
    data: {
      title: parsed.data.title,
      notes: parsed.data.notes || null,
      dueAt: parseDue(parsed.data.dueAt),
      ...links,
    },
  });

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  return saved("Saved.");
}

export async function deleteTask(formData: FormData) {
  const { user, org } = await requirePermission("tasks:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // Anyone may close a task they can see; removing one outright is for the
  // people who can see the whole list.
  const scope = can(user, "tasks:read:all")
    ? {}
    : { OR: [{ assignedToId: user.id }, { createdById: user.id }] };

  const task = await prisma.task.findFirst({
    where: { id, organizationId: org.id, ...scope },
    select: { id: true, jobId: true, clientId: true },
  });
  if (!task) return;

  await prisma.task.delete({ where: { id } });

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  if (task.jobId) revalidatePath(`/jobs/${task.jobId}`);
  if (task.clientId) revalidatePath(`/clients/${task.clientId}`);
}

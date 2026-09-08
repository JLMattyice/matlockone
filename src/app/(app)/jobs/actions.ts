"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import {
  JOB_KINDS,
  JOB_PRIORITIES,
  JOB_STATUS_FLOW,
  JOB_STATUSES,
  RECURRENCE_FREQUENCIES,
  type JobStatus,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { parseMoneyToCents } from "@/lib/money";
import { notify } from "@/lib/notifications";
import { allocateNumber } from "@/lib/numbering";
import { can } from "@/lib/permissions";
import { expandRecurrence, MAX_OCCURRENCES } from "@/lib/recurrence";
import type { Prisma } from "@/generated/prisma/client";

// ------------------------------------------------------------------ create ---

const jobSchema = z.object({
  kind: z.enum(JOB_KINDS),
  title: z.string().trim().min(1, "Give it a title."),
  description: z.string().trim().nullish(),
  clientId: z.string().trim().nullish(),
  addressId: z.string().trim().nullish(),
  status: z.enum(JOB_STATUSES),
  priority: z.enum(JOB_PRIORITIES),
  scheduledStart: z.string().trim().nullish(),
  durationMinutes: z.coerce.number().int().min(15).max(24 * 60),
  allDay: z.boolean().default(false),
  assigneeIds: z.array(z.string()),
  groupId: z.string().trim().nullish(),
  repeat: z.boolean().default(false),
  frequency: z.enum(RECURRENCE_FREQUENCIES).default("WEEKLY"),
  interval: z.coerce.number().int().min(1).max(52).default(1),
  byWeekday: z.array(z.number().int().min(0).max(6)).default([]),
  occurrences: z.coerce.number().int().min(2).max(MAX_OCCURRENCES).default(4),
});

function parseJobForm(formData: FormData) {
  return jobSchema.safeParse({
    kind: formData.get("kind") ?? "JOB",
    title: formData.get("title"),
    description: text(formData, "description"),
    clientId: text(formData, "clientId"),
    addressId: text(formData, "addressId"),
    groupId: text(formData, "groupId"),
    status: formData.get("status") ?? "SCHEDULED",
    priority: formData.get("priority") ?? "NORMAL",
    scheduledStart: text(formData, "scheduledStart"),
    durationMinutes: formData.get("durationMinutes") ?? 60,
    allDay: formData.get("allDay") === "on",
    assigneeIds: formData.getAll("assigneeIds").map(String).filter(Boolean),
    repeat: formData.get("repeat") === "on",
    frequency: formData.get("frequency") || "WEEKLY",
    interval: formData.get("interval") || 1,
    byWeekday: formData
      .getAll("byWeekday")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value)),
    occurrences: formData.get("occurrences") || 4,
  });
}

/** "2026-08-26T14:30" from a datetime-local input, read as local time. */
function parseLocalDateTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Only accept a client and address that belong to the caller's organization. */
async function resolveClientAndAddress(
  clientId: string | null | undefined,
  addressId: string | null | undefined,
  organizationId: string,
) {
  if (!clientId) return { clientId: null, addressId: null };

  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId },
    select: { id: true },
  });
  if (!client) return { clientId: null, addressId: null };

  if (!addressId) return { clientId: client.id, addressId: null };

  const address = await prisma.address.findFirst({
    where: { id: addressId, organizationId, clientId: client.id },
    select: { id: true },
  });

  return { clientId: client.id, addressId: address?.id ?? null };
}

async function resolveAssignees(ids: string[], organizationId: string) {
  if (ids.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, organizationId, isActive: true },
    select: { id: true },
  });
  return users.map((user) => user.id);
}

/**
 * The group this job belongs to, or null.
 *
 * Checked against the organization for the same reason assignees are: the id
 * arrives from a form, and an edited one must not be able to file this job
 * under another business's group.
 */
async function resolveGroup(
  groupId: string | null | undefined,
  organizationId: string,
) {
  if (!groupId) return null;
  const group = await prisma.group.findFirst({
    where: { id: groupId, organizationId },
    select: { id: true },
  });
  return group?.id ?? null;
}

export async function createJob(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:write");

  const parsed = parseJobForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const start = parseLocalDateTime(input.scheduledStart);

  if (input.repeat && !start) {
    return { ok: false, fieldErrors: { scheduledStart: "A repeating job needs a start date." } };
  }

  const { clientId, addressId } = await resolveClientAndAddress(
    input.clientId,
    input.addressId,
    org.id,
  );
  const assigneeIds = await resolveAssignees(input.assigneeIds, org.id);
  const groupId = await resolveGroup(input.groupId, org.id);

  const starts = input.repeat && start
    ? expandRecurrence(
        {
          frequency: input.frequency,
          interval: input.interval,
          byWeekday: input.byWeekday,
          count: input.occurrences,
        },
        start,
      )
    : [start];

  const firstJobId = await prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<string> => {
      let recurrenceRuleId: string | null = null;

      if (input.repeat && starts.length > 1) {
        const rule = await tx.recurrenceRule.create({
          data: {
            organizationId: org.id,
            frequency: input.frequency,
            interval: input.interval,
            byWeekday: input.byWeekday.length
              ? JSON.stringify(input.byWeekday)
              : null,
            count: input.occurrences,
          },
        });
        recurrenceRuleId = rule.id;
      }

      let parentId: string | null = null;

      for (const occurrenceStart of starts) {
        const number = await allocateNumber(tx, org.id, "job");

        // Read into a typed local first: referencing `parentId` inside the
        // payload while also assigning it from the result makes the control
        // flow circular, and TypeScript gives up on inferring the row type.
        const recurrenceParentId: string | null = parentId;

        const created: { id: string } = await tx.job.create({
          data: {
            organizationId: org.id,
            number,
            kind: input.kind,
            title: input.title,
            description: input.description ?? null,
            clientId,
            addressId,
            groupId,
            status: input.status,
            priority: input.priority,
            scheduledStart: occurrenceStart,
            scheduledEnd: occurrenceStart
              ? new Date(
                  occurrenceStart.getTime() + input.durationMinutes * 60_000,
                )
              : null,
            allDay: input.allDay,
            estimatedMinutes: input.durationMinutes,
            recurrenceRuleId,
            // The first occurrence is the parent the rest hang off.
            recurrenceParentId,
            createdById: user.id,
            assignments: {
              create: assigneeIds.map((userId, i) => ({
                userId,
                isLead: i === 0,
              })),
            },
          },
          select: { id: true },
        });

        if (parentId === null) parentId = created.id;
      }

      return parentId!;
    },
  );

  await notify({
    organizationId: org.id,
    userIds: assigneeIds,
    exceptUserId: user.id,
    type: "JOB_ASSIGNED",
    title: `Assigned: ${input.title}`,
    body: start
      ? `Scheduled for ${start.toLocaleString()}`
      : "Not scheduled yet",
    entityType: "job",
    entityId: firstJobId,
    actionUrl: `/jobs/${firstJobId}`,
  });

  revalidatePath("/jobs");
  revalidatePath("/schedule");
  redirect(`/jobs/${firstJobId}`);
}

export async function updateJob(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:write");

  const id = text(formData, "id");
  if (!id) return failed("Missing job id.");

  const existing = await prisma.job.findFirst({
    where: { id, organizationId: org.id },
    select: {
      id: true,
      title: true,
      scheduledStart: true,
      assignments: { select: { userId: true } },
    },
  });
  if (!existing) return failed("That job no longer exists.");

  const parsed = parseJobForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const start = parseLocalDateTime(input.scheduledStart);

  const { clientId, addressId } = await resolveClientAndAddress(
    input.clientId,
    input.addressId,
    org.id,
  );
  const assigneeIds = await resolveAssignees(input.assigneeIds, org.id);
  const groupId = await resolveGroup(input.groupId, org.id);

  await prisma.$transaction(async (tx) => {
    await tx.job.update({
      where: { id },
      data: {
        kind: input.kind,
        title: input.title,
        description: input.description ?? null,
        clientId,
        addressId,
        groupId,
        priority: input.priority,
        scheduledStart: start,
        scheduledEnd: start
          ? new Date(start.getTime() + input.durationMinutes * 60_000)
          : null,
        allDay: input.allDay,
        estimatedMinutes: input.durationMinutes,
      },
    });

    // Replace the assignments wholesale — the form submits the complete set.
    await tx.jobAssignment.deleteMany({ where: { jobId: id } });
    if (assigneeIds.length) {
      await tx.jobAssignment.createMany({
        data: assigneeIds.map((userId, i) => ({
          jobId: id,
          userId,
          isLead: i === 0,
        })),
      });
    }
  });

  // Only people who were not already on the job hear about it, and only when
  // something they would care about actually moved.
  const previous = new Set(existing.assignments.map((a) => a.userId));
  const added = assigneeIds.filter((userId) => !previous.has(userId));
  const movedTo = start?.getTime() ?? null;
  const movedFrom = existing.scheduledStart?.getTime() ?? null;

  await notify({
    organizationId: org.id,
    userIds: added,
    exceptUserId: user.id,
    type: "JOB_ASSIGNED",
    title: `Assigned: ${input.title}`,
    body: start ? `Scheduled for ${start.toLocaleString()}` : "Not scheduled yet",
    entityType: "job",
    entityId: id,
    actionUrl: `/jobs/${id}`,
  });

  if (movedTo !== movedFrom) {
    await notify({
      organizationId: org.id,
      userIds: assigneeIds.filter((userId) => previous.has(userId)),
      exceptUserId: user.id,
      type: "SCHEDULE_CHANGE",
      title: `Rescheduled: ${input.title}`,
      body: start ? `Now ${start.toLocaleString()}` : "Moved to unscheduled",
      entityType: "job",
      entityId: id,
      actionUrl: `/jobs/${id}`,
    });
  }

  revalidatePath("/jobs");
  revalidatePath("/schedule");
  revalidatePath(`/jobs/${id}`);
  return saved("Job updated.");
}

// ------------------------------------------------------------------ status ---

/**
 * Status changes carry timestamps with them, and moving backwards clears the
 * ones that no longer apply — a job reopened from Completed should not keep
 * claiming it finished.
 */
export async function setJobStatus(formData: FormData) {
  const { org } = await requirePermission("jobs:write");

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as JobStatus;
  if (!id || !JOB_STATUSES.includes(status)) return;

  const job = await prisma.job.findFirst({
    where: { id, organizationId: org.id },
    select: { status: true, startedAt: true },
  });
  if (!job) return;

  const current = job.status as JobStatus;
  if (current !== status && !JOB_STATUS_FLOW[current]?.includes(status)) return;

  const now = new Date();

  await prisma.job.update({
    where: { id },
    data: {
      status,
      startedAt:
        status === "IN_PROGRESS" ? (job.startedAt ?? now) : job.startedAt,
      completedAt: status === "COMPLETED" ? now : null,
      cancelledAt: status === "CANCELLED" ? now : null,
      cancelReason:
        status === "CANCELLED"
          ? (text(formData, "cancelReason") ?? null)
          : null,
    },
  });

  revalidatePath("/jobs");
  revalidatePath("/schedule");
  revalidatePath(`/jobs/${id}`);
}

/**
 * Drag-and-drop rescheduling. Keeps the job's existing duration so dropping it
 * on a new slot moves it rather than resizing it.
 */
export async function rescheduleJob(input: {
  id: string;
  startISO: string;
  durationMinutes?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const { user, org } = await requirePermission("schedule:write");

  const start = new Date(input.startISO);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Invalid date." };

  const job = await prisma.job.findFirst({
    where: { id: input.id, organizationId: org.id },
    select: {
      title: true,
      scheduledStart: true,
      scheduledEnd: true,
      estimatedMinutes: true,
      status: true,
      assignments: { select: { userId: true } },
    },
  });
  if (!job) return { ok: false, error: "That job no longer exists." };

  const existingDuration =
    job.scheduledStart && job.scheduledEnd
      ? Math.round(
          (job.scheduledEnd.getTime() - job.scheduledStart.getTime()) / 60_000,
        )
      : (job.estimatedMinutes ?? 60);

  const duration = Math.max(input.durationMinutes ?? existingDuration, 15);

  await prisma.job.update({
    where: { id: input.id },
    data: {
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + duration * 60_000),
    },
  });

  await notify({
    organizationId: org.id,
    userIds: job.assignments.map((a) => a.userId),
    exceptUserId: user.id,
    type: "SCHEDULE_CHANGE",
    title: `Rescheduled: ${job.title}`,
    body: `Now ${start.toLocaleString()}`,
    entityType: "job",
    entityId: input.id,
    actionUrl: `/jobs/${input.id}`,
  });

  revalidatePath("/schedule");
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${input.id}`);
  return { ok: true };
}

export async function deleteJob(formData: FormData) {
  const { org } = await requirePermission("jobs:delete");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const job = await prisma.job.findFirst({
    where: { id, organizationId: org.id },
    select: { _count: { select: { invoices: true } } },
  });
  if (!job) return;

  // A job that has been billed is cancelled rather than removed, so the
  // invoice does not end up pointing at nothing.
  if (job._count.invoices > 0) {
    await prisma.job.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    revalidatePath(`/jobs/${id}`);
    return;
  }

  await prisma.job.deleteMany({ where: { id, organizationId: org.id } });
  revalidatePath("/jobs");
  revalidatePath("/schedule");
  redirect("/jobs");
}

// --------------------------------------------------------------- materials ---

const materialSchema = z.object({
  jobId: z.string().min(1),
  name: z.string().trim().min(1, "Name the material."),
  quantity: z.coerce.number().min(0.01).max(100000),
  unit: z.string().trim().min(1).default("ea"),
  unitCost: z.string().trim().nullish(),
  billable: z.boolean().default(true),
});

export async function addJobMaterial(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("jobs:write");

  const parsed = materialSchema.safeParse({
    jobId: formData.get("jobId"),
    name: formData.get("name"),
    quantity: formData.get("quantity") || 1,
    unit: formData.get("unit") || "ea",
    unitCost: text(formData, "unitCost"),
    billable: formData.get("billable") !== "off",
  });

  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const job = await prisma.job.findFirst({
    where: { id: input.jobId, organizationId: org.id },
    select: { id: true },
  });
  if (!job) return failed("That job no longer exists.");

  const unitCostCents = parseMoneyToCents(input.unitCost ?? null) ?? 0;

  await prisma.jobMaterial.create({
    data: {
      organizationId: org.id,
      jobId: job.id,
      name: input.name,
      quantity: input.quantity,
      unit: input.unit,
      unitCostCents,
      totalCents: Math.round(input.quantity * unitCostCents),
      billable: input.billable,
    },
  });

  revalidatePath(`/jobs/${job.id}`);
  return saved("Material added.");
}

export async function deleteJobMaterial(formData: FormData) {
  const { org } = await requirePermission("jobs:write");

  const id = String(formData.get("id") ?? "");
  const jobId = String(formData.get("jobId") ?? "");
  if (!id) return;

  await prisma.jobMaterial.deleteMany({ where: { id, organizationId: org.id } });
  revalidatePath(`/jobs/${jobId}`);
}

// ------------------------------------------------------------ time tracking ---

const timeSchema = z.object({
  jobId: z.string().min(1),
  userId: z.string().min(1),
  startedAt: z.string().trim().min(1, "Pick a start time."),
  minutes: z.coerce.number().int().min(1).max(24 * 60),
  billable: z.boolean().default(true),
  notes: z.string().trim().nullish(),
});

export async function addTimeEntry(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:log-time");

  const parsed = timeSchema.safeParse({
    jobId: formData.get("jobId"),
    userId: formData.get("userId") || user.id,
    startedAt: formData.get("startedAt"),
    minutes: formData.get("minutes") || 60,
    billable: formData.get("billable") !== "off",
    notes: text(formData, "notes"),
  });

  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;

  const job = await prisma.job.findFirst({
    where: { id: input.jobId, organizationId: org.id },
    select: { id: true },
  });
  if (!job) return failed("That job no longer exists.");

  // An employee can only log their own hours; a manager can log anyone's.
  const targetUserId = can(user, "jobs:assign") ? input.userId : user.id;

  const crew = await prisma.user.findFirst({
    where: { id: targetUserId, organizationId: org.id },
    select: { id: true, hourlyRateCents: true },
  });
  if (!crew) return failed("That team member no longer exists.");

  const startedAt = parseLocalDateTime(input.startedAt);
  if (!startedAt) return { ok: false, fieldErrors: { startedAt: "Invalid date." } };

  await prisma.timeEntry.create({
    data: {
      organizationId: org.id,
      jobId: job.id,
      userId: crew.id,
      startedAt,
      endedAt: new Date(startedAt.getTime() + input.minutes * 60_000),
      minutes: input.minutes,
      // Snapshot the rate: a later raise must not restate past labor cost.
      hourlyRateCents: crew.hourlyRateCents ?? 0,
      billable: input.billable,
      notes: input.notes ?? null,
    },
  });

  revalidatePath(`/jobs/${job.id}`);
  return saved("Time logged.");
}

export async function deleteTimeEntry(formData: FormData) {
  const { user, org } = await requirePermission("jobs:log-time");

  const id = String(formData.get("id") ?? "");
  const jobId = String(formData.get("jobId") ?? "");
  if (!id) return;

  const entry = await prisma.timeEntry.findFirst({
    where: { id, organizationId: org.id },
    select: { userId: true },
  });
  if (!entry) return;

  if (entry.userId !== user.id && !can(user, "jobs:assign")) return;

  await prisma.timeEntry.deleteMany({ where: { id, organizationId: org.id } });
  revalidatePath(`/jobs/${jobId}`);
}

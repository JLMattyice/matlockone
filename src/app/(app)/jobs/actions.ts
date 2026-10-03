"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  JOB_KINDS,
  JOB_PRIORITIES,
  JOB_STATUS_FLOW,
  JOB_STATUS_META,
  JOB_STATUSES,
  RECURRENCE_FREQUENCIES,
  type JobKind,
  type JobStatus,
} from "@/lib/constants";
import { record } from "@/lib/activity";
import { joinJobThread } from "@/lib/conversations";
import { prisma } from "@/lib/db";
import { parseCategoryValue } from "@/lib/job-categories";
import { attachCategoryChecklists } from "@/lib/job-checklist";
import { parseMoneyToCents } from "@/lib/money";
import { notify } from "@/lib/notifications";
import { allocateNumber } from "@/lib/numbering";
import { can } from "@/lib/permissions";
import { expandRecurrence, MAX_OCCURRENCES } from "@/lib/recurrence";
import { formatIn, parseDateTimeLocal } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";
import type { Prisma } from "@/generated/prisma/client";

// ------------------------------------------------------------------ create ---

const jobSchema = z.object({
  category: z.string().trim(),
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
    // "kind" is what the form posted before a business could add its own.
    category: formData.get("category") ?? formData.get("kind") ?? "JOB",
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

/** "Tue, Sep 29 at 9:00 PM" — a start time as a notification says it. */
function when(date: Date, zone: string) {
  return formatIn(date, "EEE, MMM d 'at' h:mm a", zone);
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
 * The kind an entry is stored as, and its own category if it has one — or
 * null when the choice names a category that is not this business's.
 *
 * The kind comes from the category, never from the form, so an entry filed
 * under a category always behaves as that category says.
 */
async function resolveCategory(
  value: string,
  organizationId: string,
): Promise<{ kind: JobKind; categoryId: string | null } | null> {
  const choice = parseCategoryValue(value);
  if (!choice) return null;
  if (choice.kind !== null) return { kind: choice.kind, categoryId: null };

  const category = await prisma.jobCategory.findFirst({
    where: { id: choice.categoryId, organizationId },
    select: { id: true, kind: true },
  });
  return category
    ? { kind: asStatus(JOB_KINDS, category.kind, "OTHER"), categoryId: category.id }
    : null;
}

const CATEGORY_GONE = {
  ok: false,
  fieldErrors: { category: "That category has been deleted. Pick another." },
} satisfies ActionState;

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
  // The time was typed on the clock of the machine it was typed on.
  const zone = await viewerTimeZone();
  const start = parseDateTimeLocal(input.scheduledStart, zone);

  if (input.repeat && !start) {
    return { ok: false, fieldErrors: { scheduledStart: "A repeating job needs a start date." } };
  }

  const category = await resolveCategory(input.category, org.id);
  if (!category) return CATEGORY_GONE;

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
        zone,
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
            kind: category.kind,
            categoryId: category.categoryId,
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

        // Every visit gets its own copy of the category's checklists.
        await attachCategoryChecklists(tx, {
          organizationId: org.id,
          jobId: created.id,
          kind: category.kind,
          categoryId: category.categoryId,
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
    body: start ? `Scheduled for ${when(start, zone)}` : "Not scheduled yet",
    entityType: "job",
    entityId: firstJobId,
    actionUrl: `/jobs/${firstJobId}`,
  });

  await record({
    organizationId: org.id,
    userId: user.id,
    action: "job.created",
    entityType: "JOB",
    entityId: firstJobId,
    summary: `${org.labelJobSingular} created — ${input.title}`,
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
      kind: true,
      categoryId: true,
      scheduledStart: true,
      assignments: { select: { userId: true } },
      _count: { select: { checklistItems: true } },
    },
  });
  if (!existing) return failed("That job no longer exists.");

  const parsed = parseJobForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const zone = await viewerTimeZone();
  const start = parseDateTimeLocal(input.scheduledStart, zone);

  const category = await resolveCategory(input.category, org.id);
  if (!category) return CATEGORY_GONE;

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
        kind: category.kind,
        categoryId: category.categoryId,
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

    // Moved into a category with its own checklist before any was put on:
    // it gets that list, as it would have if booked there in the first place.
    const recategorized =
      existing.kind !== category.kind || existing.categoryId !== category.categoryId;
    if (recategorized && existing._count.checklistItems === 0) {
      await attachCategoryChecklists(tx, {
        organizationId: org.id,
        jobId: id,
        kind: category.kind,
        categoryId: category.categoryId,
      });
    }

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
    body: start ? `Scheduled for ${when(start, zone)}` : "Not scheduled yet",
    entityType: "job",
    entityId: id,
    actionUrl: `/jobs/${id}`,
  });

  // Whoever was just put on the job gets its conversation in their inbox, with
  // the history there to read but not counted against them as unread.
  await joinJobThread({ organizationId: org.id, jobId: id, userIds: added });

  if (movedTo !== movedFrom) {
    await notify({
      organizationId: org.id,
      userIds: assigneeIds.filter((userId) => previous.has(userId)),
      exceptUserId: user.id,
      type: "SCHEDULE_CHANGE",
      title: `Rescheduled: ${input.title}`,
      body: start ? `Now ${when(start, zone)}` : "Moved to unscheduled",
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
  const { user, org } = await requirePermission("jobs:write");

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as JobStatus;
  if (!id || !JOB_STATUSES.includes(status)) return;

  const job = await prisma.job.findFirst({
    where: { id, organizationId: org.id },
    select: { status: true, startedAt: true, number: true, title: true },
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

  await record({
    organizationId: org.id,
    userId: user.id,
    action: "job.status",
    entityType: "JOB",
    entityId: id,
    summary: `${org.labelJobSingular} ${job.number} marked ${JOB_STATUS_META[status].label.toLowerCase()}`,
    metadata: { from: current, to: status },
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
    body: `Now ${when(start, await viewerTimeZone())}`,
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

  // The job's conversation goes with it. The foreign key says so too, but a
  // desktop install that gained Conversation.jobId on upgrade got the column
  // without the key — SQLite cannot add one to an existing table — so the
  // thread would otherwise outlive its job there.
  await prisma.$transaction([
    prisma.conversation.deleteMany({ where: { jobId: id, organizationId: org.id } }),
    prisma.job.deleteMany({ where: { id, organizationId: org.id } }),
  ]);
  revalidatePath("/jobs");
  revalidatePath("/messages", "layout");
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

  const startedAt = parseDateTimeLocal(input.startedAt, await viewerTimeZone());
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

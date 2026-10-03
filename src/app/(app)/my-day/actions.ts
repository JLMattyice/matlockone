"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission, type SessionUser } from "@/lib/auth";
import type { JobStatus } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { changeJobStatus } from "@/lib/job-status";
import { can, jobVisibilityWhere } from "@/lib/permissions";
import { clockIn, clockOut, openClock, runningTimer, startTimer, stopTimer } from "@/lib/time-clock";
import { parseDateTimeLocal } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

/**
 * My Day: the clock, the job timer, and starting and finishing a visit.
 *
 * All of it is field work, so it rides on jobs:log-time. Starting and
 * completing a visit moves its status, which the crew cannot do on the job
 * page; here they can, for a job they are assigned to — the person standing
 * at the finished work is the one who knows it is done.
 */

function refresh(jobId?: string) {
  revalidatePath("/my-day");
  revalidatePath("/team/time-clock");
  if (jobId) {
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
    revalidatePath("/schedule");
  }
}

export async function clockInNow(_prev: ActionState): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:log-time");
  await clockIn({ organizationId: org.id, userId: user.id });
  refresh();
  return saved("Clocked in.");
}

/**
 * Clocks out now, or at a time given for somebody who forgot yesterday —
 * never later than now, and never before they clocked in.
 */
export async function clockOutNow(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:log-time");
  const who = { organizationId: org.id, userId: user.id };

  const open = await openClock(who);
  if (!open) {
    refresh();
    return saved("You were not clocked in.");
  }

  let at = new Date();
  const typed = text(formData, "at");
  if (typed) {
    const parsed = parseDateTimeLocal(typed, await viewerTimeZone());
    if (!parsed) return { ok: false, fieldErrors: { at: "Pick when you stopped." } };
    if (parsed > at) return { ok: false, fieldErrors: { at: "That is still to come." } };
    if (parsed <= open.clockedInAt) {
      return { ok: false, fieldErrors: { at: "That is before you clocked in." } };
    }
    at = parsed;
  }

  await clockOut(who, at);
  refresh();
  return saved("Clocked out.");
}

/** The job, if this person may work on it: they can see it and it is not finished. */
async function workableJob(org: { id: string }, user: SessionUser, jobId: string) {
  return prisma.job.findFirst({
    where: {
      id: jobId,
      organizationId: org.id,
      status: { notIn: ["CANCELLED"] },
      ...jobVisibilityWhere(user),
    },
    select: {
      id: true,
      status: true,
      assignments: { where: { userId: user.id }, select: { id: true } },
    },
  });
}

/** Whether this person may move the job's status from My Day. */
function mayMove(user: SessionUser, job: { assignments: unknown[] }) {
  return can(user, "jobs:write") || job.assignments.length > 0;
}

/** Starts the timer on a visit, and marks it in progress. */
export async function startVisit(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:log-time");
  const job = await workableJob(org, user, String(formData.get("jobId") ?? ""));
  if (!job) return failed("That job is not on your list any more.");
  if (job.status === "COMPLETED") return failed("That job is already completed.");

  await startTimer({ organizationId: org.id, userId: user.id }, job.id);

  if ((job.status === "SCHEDULED" || job.status === "CONFIRMED") && mayMove(user, job)) {
    await changeJobStatus({
      organizationId: org.id,
      actorId: user.id,
      jobLabel: org.labelJobSingular,
      jobId: job.id,
      status: "IN_PROGRESS",
    });
  }

  refresh(job.id);
  return saved("Started.");
}

export async function stopVisitTimer(_prev: ActionState): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:log-time");
  const running = await runningTimer({ organizationId: org.id, userId: user.id });
  await stopTimer({ organizationId: org.id, userId: user.id });
  refresh(running?.job.id);
  return saved("Timer stopped.");
}

/**
 * Finishes a visit: stops its timer and marks it completed. An open checklist
 * item does not stop it — the owner chose "track only".
 */
export async function completeVisit(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:log-time");
  const job = await workableJob(org, user, String(formData.get("jobId") ?? ""));
  if (!job) return failed("That job is not on your list any more.");
  if (!mayMove(user, job)) return failed("Only the crew on this job, or the office, can complete it.");

  const who = { organizationId: org.id, userId: user.id };
  const running = await runningTimer(who);
  if (running?.job.id === job.id) await stopTimer(who);

  // The flow goes through In progress; a visit finished without pressing
  // Start goes through it on the way.
  const steps: JobStatus[] =
    job.status === "IN_PROGRESS" ? ["COMPLETED"] : job.status === "COMPLETED" ? [] : ["IN_PROGRESS", "COMPLETED"];
  for (const status of steps) {
    await changeJobStatus({
      organizationId: org.id,
      actorId: user.id,
      jobLabel: org.labelJobSingular,
      jobId: job.id,
      status,
    });
  }

  refresh(job.id);
  return saved("Marked complete.");
}

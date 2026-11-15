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

/** Everywhere this person's clock and timer show: their day, their sheet, the team's. */
function refresh(userId: string, jobId?: string) {
  revalidatePath("/my-day");
  revalidatePath("/my-day/hours");
  revalidatePath("/team/time-clock");
  revalidatePath(`/team/time-clock/${userId}`);
  if (jobId) {
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
    revalidatePath("/schedule");
  }
}

/**
 * A job this person may put time on: one they can see that is still open.
 * Wider than today's visits — the job from last week that needs an hour more,
 * the one nobody booked — and it moves no status: saying what you are working
 * on is not saying a visit has begun.
 */
async function timeableJob(org: { id: string }, user: SessionUser, jobId: string) {
  return prisma.job.findFirst({
    where: {
      id: jobId,
      organizationId: org.id,
      status: { notIn: ["CANCELLED", "COMPLETED"] },
      ...jobVisibilityWhere(user),
    },
    select: { id: true },
  });
}

/**
 * Clocks in. A job may be named with it — the clock asks, and nobody has to
 * answer — and then its timer starts in the same tap.
 */
export async function clockInNow(_prev: ActionState, formData?: FormData): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:log-time");
  const who = { organizationId: org.id, userId: user.id };

  const jobId = formData ? text(formData, "jobId") : null;
  if (jobId) {
    const job = await timeableJob(org, user, jobId);
    if (!job) return failed("That job is not open to you any more. Pick another, or clock in without one.");
    // Starting a timer clocks in first.
    await startTimer(who, job.id);
    refresh(user.id, job.id);
    return saved("Clocked in.");
  }

  await clockIn(who);
  refresh(user.id);
  return saved("Clocked in.");
}

/**
 * Puts the timer on a job picked from the clock or pressed on the job's own
 * page: any open job this person can see, not only today's visits. Whatever
 * was running stops, and it clocks in somebody who was not.
 */
export async function workOnJob(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:log-time");

  const jobId = text(formData, "jobId");
  if (!jobId) return { ok: false, fieldErrors: { jobId: "Pick what you are working on." } };
  const job = await timeableJob(org, user, jobId);
  if (!job) return failed("That job is not open to you any more.");

  await startTimer({ organizationId: org.id, userId: user.id }, job.id);
  refresh(user.id, job.id);
  return saved("Timer started.");
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
    refresh(user.id);
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
  refresh(user.id);
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

  refresh(user.id, job.id);
  return saved("Started.");
}

export async function stopVisitTimer(_prev: ActionState): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:log-time");
  const running = await runningTimer({ organizationId: org.id, userId: user.id });
  await stopTimer({ organizationId: org.id, userId: user.id });
  refresh(user.id, running?.job.id);
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

  refresh(user.id, job.id);
  return saved("Marked complete.");
}

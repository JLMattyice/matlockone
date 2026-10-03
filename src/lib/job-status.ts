import "server-only";

import { record } from "./activity";
import { JOB_STATUS_FLOW, JOB_STATUS_META, JOB_STATUSES, type JobStatus } from "./constants";
import { prisma } from "./db";

/**
 * Moves a job along its status flow.
 *
 * Status changes carry timestamps with them, and moving backwards clears the
 * ones that no longer apply — a job reopened from Completed should not keep
 * claiming it finished. A move the flow does not allow is refused. Returns
 * whether it moved.
 */
export async function changeJobStatus(input: {
  organizationId: string;
  actorId: string;
  jobLabel: string;
  jobId: string;
  status: JobStatus;
  cancelReason?: string | null;
}): Promise<boolean> {
  const { organizationId, jobId, status } = input;
  if (!JOB_STATUSES.includes(status)) return false;

  const job = await prisma.job.findFirst({
    where: { id: jobId, organizationId },
    select: { status: true, startedAt: true, number: true },
  });
  if (!job) return false;

  const current = job.status as JobStatus;
  if (current !== status && !JOB_STATUS_FLOW[current]?.includes(status)) return false;

  const now = new Date();

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status,
      startedAt: status === "IN_PROGRESS" ? (job.startedAt ?? now) : job.startedAt,
      completedAt: status === "COMPLETED" ? now : null,
      cancelledAt: status === "CANCELLED" ? now : null,
      cancelReason: status === "CANCELLED" ? (input.cancelReason ?? null) : null,
    },
  });

  await record({
    organizationId,
    userId: input.actorId,
    action: "job.status",
    entityType: "JOB",
    entityId: jobId,
    summary: `${input.jobLabel} ${job.number} marked ${JOB_STATUS_META[status].label.toLowerCase()}`,
    metadata: { from: current, to: status },
  });

  return true;
}

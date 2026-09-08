import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { JobForm } from "../../job-form";
import { activeCrew, clientOptions, getJob } from "../../queries";
import { assignableGroups } from "../../../team/groups/queries";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  JOB_KINDS,
  JOB_PRIORITIES,
  JOB_STATUSES,
  type JobKind,
  type JobPriority,
  type JobStatus,
} from "@/lib/constants";
import { can } from "@/lib/permissions";
import { durationMinutes, toDateTimeLocal } from "@/lib/utils";

export const metadata: Metadata = { title: "Edit job" };

export default async function EditJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requirePermission("jobs:write");
  const { id } = await params;

  const [job, clients, crew, groups] = await Promise.all([
    getJob(ctx, id),
    clientOptions(ctx.org.id),
    activeCrew(ctx.org.id),
    assignableGroups(ctx.org.id),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={`/jobs/${job.id}`}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          {job.number}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Edit {ctx.org.labelJobSingular.toLowerCase()}
        </h1>
      </div>

      <JobForm
        clients={clients}
        crew={crew}
        groups={groups}
        jobLabel={ctx.org.labelJobSingular}
        canAssign={can(ctx.user, "jobs:assign")}
        values={{
          id: job.id,
          kind: asStatus(JOB_KINDS, job.kind, "JOB") as JobKind,
          title: job.title,
          description: job.description ?? "",
          clientId: job.clientId ?? "",
          addressId: job.addressId ?? "",
          status: asStatus(JOB_STATUSES, job.status, "SCHEDULED") as JobStatus,
          priority: asStatus(
            JOB_PRIORITIES,
            job.priority,
            "NORMAL",
          ) as JobPriority,
          scheduledStart: toDateTimeLocal(job.scheduledStart),
          durationMinutes: durationMinutes(
            job.scheduledStart,
            job.scheduledEnd,
            job.estimatedMinutes ?? 60,
          ),
          allDay: job.allDay,
          assigneeIds: job.assignments.map((a) => a.userId),
          groupId: job.groupId ?? "",
        }}
      />
    </div>
  );
}

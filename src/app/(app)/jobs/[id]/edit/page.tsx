import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { JobForm } from "../../job-form";
import { activeCrew, clientOptions, getJob } from "../../queries";
import { jobCategories } from "../../../settings/calendar/queries";
import { assignableGroups } from "../../../team/groups/queries";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  JOB_PRIORITIES,
  JOB_STATUSES,
  type JobPriority,
  type JobStatus,
} from "@/lib/constants";
import {
  categoryOptions,
  categoryValue,
  parseHiddenKinds,
} from "@/lib/job-categories";
import { can } from "@/lib/permissions";
import { toDateTimeLocal } from "@/lib/time-zone";
import { durationMinutes } from "@/lib/utils";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "Edit job" };

export default async function EditJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requirePermission("jobs:write");
  const { id } = await params;

  const [job, clients, crew, groups, zone, categories] = await Promise.all([
    getJob(ctx, id),
    clientOptions(ctx.org.id),
    activeCrew(ctx.org.id),
    assignableGroups(ctx.org.id),
    viewerTimeZone(),
    jobCategories(ctx.org.id),
  ]);

  const category = categoryValue(job);

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
        categories={categoryOptions({
          categories,
          hiddenKinds: parseHiddenKinds(ctx.org.hiddenJobKinds),
          jobLabel: ctx.org.labelJobSingular,
          jobPlural: ctx.org.labelJobPlural,
          // A hidden built-in stays on offer for the entry already using it.
          keep: category,
        })}
        canAssign={can(ctx.user, "jobs:assign")}
        canManageCategories={can(ctx.user, "settings:write")}
        values={{
          id: job.id,
          category,
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
          scheduledStart: toDateTimeLocal(job.scheduledStart, zone),
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

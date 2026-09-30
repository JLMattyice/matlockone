import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { JobForm } from "../job-form";
import { activeCrew, clientOptions } from "../queries";
import { assignableGroups } from "../../team/groups/queries";
import { requirePermission } from "@/lib/auth";
import { asStatus, JOB_KINDS } from "@/lib/constants";
import { can } from "@/lib/permissions";
import { parseDateTimeLocal, toDateTimeLocal } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "New job" };

export default async function NewJobPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; clientId?: string; kind?: string }>;
}) {
  const { user, org } = await requirePermission("jobs:write");
  const params = await searchParams;

  const [clients, crew, groups, zone] = await Promise.all([
    clientOptions(org.id),
    activeCrew(org.id),
    assignableGroups(org.id),
    viewerTimeZone(),
  ]);

  // The calendar links here with ?date= when you click an empty slot: a time
  // on the clock of whoever clicked it.
  const scheduledStart = toDateTimeLocal(parseDateTimeLocal(params.date, zone), zone);

  const client = params.clientId
    ? clients.find((c) => c.id === params.clientId)
    : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/jobs"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          {org.labelJobPlural}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          New {org.labelJobSingular.toLowerCase()}
        </h1>
      </div>

      <JobForm
        clients={clients}
        crew={crew}
        groups={groups}
        jobLabel={org.labelJobSingular}
        canAssign={can(user, "jobs:assign")}
        values={{
          kind: asStatus(JOB_KINDS, params.kind, "JOB"),
          title: "",
          description: "",
          clientId: client?.id ?? "",
          addressId: client?.addresses.find((a) => a.isPrimary)?.id ?? "",
          status: "SCHEDULED",
          priority: "NORMAL",
          scheduledStart,
          durationMinutes: 60,
          allDay: false,
          assigneeIds: [],
          groupId: "",
        }}
      />
    </div>
  );
}

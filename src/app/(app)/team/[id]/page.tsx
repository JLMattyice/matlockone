import type { Metadata } from "next";
import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock,
  Mail,
  Pencil,
  Phone,
} from "lucide-react";

import { ResetPassword } from "./reset-password";
import { setTeamMemberActive } from "../actions";
import { getTeamMember, memberWorkload } from "../queries";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/page-header";
import { getContext, requirePermission } from "@/lib/auth";
import {
  asStatus,
  JOB_STATUS_META,
  JOB_STATUSES,
  ROLE_META,
  ROLES,
  type Role,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { can, canManageRole, permissionsFor } from "@/lib/permissions";
import { formatPhone } from "@/lib/utils";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const ctx = await getContext();
  if (!ctx) return { title: "Team member" };

  const { id } = await params;
  const member = await prisma.user.findFirst({
    where: { id, organizationId: ctx.org.id },
    select: { name: true },
  });

  return { title: member?.name ?? "Team member" };
}

export default async function TeamMemberPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, org } = await requirePermission("employees:read");
  const { id } = await params;

  const [member, workload] = await Promise.all([
    getTeamMember(org.id, id),
    memberWorkload(org.id, id),
  ]);

  const role = asStatus(ROLES, member.role, "EMPLOYEE") as Role;
  const meta = ROLE_META[role];
  const manageable = can(user, "employees:write") && canManageRole(user, role);
  const isSelf = member.id === user.id;
  const seesMoney = can(user, "invoices:read");

  const hours = Math.round((workload.minutesThisMonth / 60) * 10) / 10;

  return (
    <div className="space-y-6">
      <Link
        href="/team"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        Team
      </Link>

      <Card>
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
          <Avatar name={member.name} imageUrl={member.avatarUrl} size="lg" />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-ink">
                {member.name}
              </h1>
              <Badge tone={meta.tone}>{meta.label}</Badge>
              {!member.isActive ? <Badge tone="danger">Deactivated</Badge> : null}
              {isSelf ? <Badge>You</Badge> : null}
            </div>

            {member.position ? (
              <p className="mt-0.5 text-sm text-ink-muted">{member.position}</p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
              <a
                href={`mailto:${member.email}`}
                className="inline-flex items-center gap-1.5 text-ink-muted transition-colors hover:text-brand"
              >
                <Mail className="h-3.5 w-3.5 text-ink-subtle" strokeWidth={1.75} />
                {member.email}
              </a>
              {member.phone ? (
                <a
                  href={`tel:${member.phone}`}
                  className="inline-flex items-center gap-1.5 text-ink-muted transition-colors hover:text-brand"
                >
                  <Phone className="h-3.5 w-3.5 text-ink-subtle" strokeWidth={1.75} />
                  {formatPhone(member.phone)}
                </a>
              ) : null}
            </div>
          </div>

          {manageable ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Link
                href={`/team/${member.id}/edit`}
                className={buttonClasses("outline", "md")}
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                Edit
              </Link>

              {!isSelf ? (
                <form action={setTeamMemberActive}>
                  <input type="hidden" name="id" value={member.id} />
                  <input
                    type="hidden"
                    name="active"
                    value={member.isActive ? "false" : "true"}
                  />
                  {member.isActive ? (
                    <ConfirmButton
                      variant="ghost"
                      size="md"
                      confirmLabel="Deactivate?"
                    >
                      Deactivate
                    </ConfirmButton>
                  ) : (
                    <button
                      type="submit"
                      className={buttonClasses("outline", "md")}
                    >
                      Reactivate
                    </button>
                  )}
                </form>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-2 divide-line border-t border-line sm:grid-cols-4 sm:divide-x">
          <Figure label="Open work" value={String(workload.upcoming.length)} />
          <Figure
            label="Completed"
            value={String(workload.completedCount)}
            sub="All time"
          />
          <Figure
            label="Hours this month"
            value={hours ? `${hours}h` : "—"}
            sub={format(new Date(), "MMMM")}
          />
          <Figure
            label={seesMoney ? "Hourly rate" : "Last seen"}
            value={
              seesMoney
                ? member.hourlyRateCents
                  ? `${formatMoney(member.hourlyRateCents, org.currency, org.locale)}`
                  : "—"
                : member.lastLoginAt
                  ? `${formatDistanceToNow(member.lastLoginAt)} ago`
                  : "Never"
            }
          />
        </div>

        {manageable && !isSelf ? (
          <div className="border-t border-line bg-surface-2 px-5 py-4">
            <ResetPassword memberId={member.id} />
          </div>
        ) : null}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="overflow-hidden">
            <CardHeader
              title="Upcoming work"
              description="Assigned and still open"
            />
            {workload.upcoming.length === 0 ? (
              <EmptyState
                icon={<CalendarClock className="h-5 w-5" strokeWidth={1.75} />}
                title="Nothing assigned"
              />
            ) : (
              <ul className="divide-y divide-line">
                {workload.upcoming.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Recently completed" />
            {workload.recent.length === 0 ? (
              <EmptyState
                icon={<CheckCircle2 className="h-5 w-5" strokeWidth={1.75} />}
                title="No completed work yet"
              />
            ) : (
              <ul className="divide-y divide-line">
                {workload.recent.map((job) => (
                  <JobRow key={job.id} job={job} completed />
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Account" />
            <dl className="divide-y divide-line text-sm">
              <Row label="Added">{format(member.createdAt, "MMM d, yyyy")}</Row>
              <Row label="Last signed in">
                {member.lastLoginAt
                  ? `${formatDistanceToNow(member.lastLoginAt)} ago`
                  : "Never"}
              </Row>
              <Row label="Status">
                {member.isActive ? "Active" : "Deactivated"}
              </Row>
            </dl>
          </Card>

          <Card>
            <CardHeader
              title="Permissions"
              description={meta.description}
            />
            <div className="px-5 py-4">
              <p className="mb-2 text-xs text-ink-subtle">
                {permissionsFor(role).length} permissions granted by the{" "}
                {meta.label} role.
              </p>
              <div className="flex flex-wrap gap-1">
                {permissionsFor(role).map((permission) => (
                  <span
                    key={permission}
                    className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.6875rem] text-ink-muted"
                  >
                    {permission}
                  </span>
                ))}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function JobRow({
  job,
  completed,
}: {
  job: {
    id: string;
    number: string;
    title: string;
    status: string;
    scheduledStart: Date | null;
    completedAt?: Date | null;
    client: { id: string; displayName: string } | null;
  };
  completed?: boolean;
}) {
  const meta = JOB_STATUS_META[asStatus(JOB_STATUSES, job.status, "SCHEDULED")];
  const when = completed ? job.completedAt : job.scheduledStart;

  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <Link
          href={`/jobs/${job.id}`}
          className="block truncate text-sm font-medium text-ink transition-colors hover:text-brand"
        >
          {job.title}
        </Link>
        <p className="truncate text-xs text-ink-subtle">
          {job.number}
          {job.client ? ` · ${job.client.displayName}` : ""}
          {when ? ` · ${format(when, "MMM d, yyyy")}` : ""}
        </p>
      </div>
      <Badge tone={meta.tone}>{meta.label}</Badge>
    </li>
  );
}

function Figure({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="px-5 py-3.5">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="tabular mt-0.5 text-lg font-semibold text-ink">{value}</p>
      {sub ? <p className="text-xs text-ink-subtle">{sub}</p> : null}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-4 px-5 py-2.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{children}</dd>
    </div>
  );
}

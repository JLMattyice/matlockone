import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, User } from "lucide-react";

import { AddClockEntry } from "../add-entry";
import { PersonTimesheet } from "@/components/timesheet/person-timesheet";
import { RangeBar } from "@/components/timesheet/range-bar";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getContext, requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { entryDefaults, loadTimesheets, rangeQuery, timesheetPresets, timesheetRange } from "@/lib/timesheet";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const ctx = await getContext();
  if (!ctx) return { title: "Timesheet" };

  const { id } = await params;
  const member = await prisma.user.findFirst({
    where: { id, organizationId: ctx.org.id },
    select: { name: true },
  });

  return { title: member ? `${member.name} · Timesheet` : "Timesheet" };
}

/**
 * One person's timesheet, for whoever looks after the team: each day's
 * stretches on the clock, the jobs the time went on, and the total for the
 * span. Whoever schedules the crews can fix a stretch here or enter a day
 * nobody clocked.
 */
export default async function PersonTimesheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string; week?: string }>;
}) {
  const { user, org } = await requirePermission("employees:read");
  const zone = await viewerTimeZone();
  const { id } = await params;
  const range = timesheetRange(await searchParams, zone);
  const now = new Date();

  const member = await prisma.user.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true, name: true, position: true, isActive: true },
  });
  if (!member) notFound();

  const [sheet] = await loadTimesheets({ organizationId: org.id, range, zone, userId: member.id, now });
  const canFix = can(user, "jobs:assign");

  return (
    <div className="space-y-6">
      <Link
        href={`/team/time-clock?${rangeQuery(range)}`}
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        Time clock
      </Link>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {member.name}
            {member.isActive ? null : <Badge tone="danger">Deactivated</Badge>}
            {member.id === user.id ? <Badge>You</Badge> : null}
          </span>
        }
        description={member.position ? `${member.position} · hours on the clock` : "Hours on the clock"}
        actions={
          <Link href={`/team/${member.id}`} className={buttonClasses("outline", "md")}>
            <User className="h-3.5 w-3.5" strokeWidth={2} />
            Profile
          </Link>
        }
      />

      <RangeBar path={`/team/time-clock/${member.id}`} range={range} presets={timesheetPresets(zone)} />

      <PersonTimesheet
        sheet={sheet}
        range={range}
        zone={zone}
        canFix={canFix}
        linkJobs={can(user, "jobs:read:all")}
        jobLabel={org.labelJobSingular}
        emptyHint={`${member.name.split(" ")[0]} did not clock in during this span.`}
      />

      {canFix ? (
        <Card>
          <AddClockEntry people={[]} person={member} standalone {...entryDefaults(range, zone, now)} />
        </Card>
      ) : null}
    </div>
  );
}

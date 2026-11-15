import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { PersonTimesheet } from "@/components/timesheet/person-timesheet";
import { RangeBar } from "@/components/timesheet/range-bar";
import { PageHeader } from "@/components/ui/page-header";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { loadTimesheets, timesheetPresets, timesheetRange } from "@/lib/timesheet";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "My hours" };

/**
 * My hours: the crew's own timesheet. The same sheet the office reads — each
 * day's stretches, the jobs the time went on, the total for the week or the
 * pay period — so nobody waits for payday to find a missing afternoon.
 *
 * Their own and nobody else's: the person is always whoever is signed in,
 * never something the address names. Read-only; the office fixes a mistake.
 */
export default async function MyHoursPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; week?: string }>;
}) {
  const { user, org } = await requirePermission("jobs:log-time");
  const zone = await viewerTimeZone();
  const range = timesheetRange(await searchParams, zone);

  const [sheet] = await loadTimesheets({ organizationId: org.id, range, zone, userId: user.id });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href="/my-day"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        My Day
      </Link>

      <PageHeader title="My hours" description="Your time on the clock. If a day looks wrong, ask the office to fix it." />

      <RangeBar path="/my-day/hours" range={range} presets={timesheetPresets(zone)} />

      <PersonTimesheet
        sheet={sheet}
        range={range}
        zone={zone}
        canFix={false}
        linkJobs={can(user, "jobs:read:all")}
        jobLabel={org.labelJobSingular}
        emptyHint="Clock in on My Day and your hours show up here."
      />
    </div>
  );
}

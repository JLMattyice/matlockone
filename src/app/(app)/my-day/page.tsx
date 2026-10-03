import type { Metadata } from "next";
import Link from "next/link";
import { CalendarCheck, Clock, ListChecks, MapPin, Timer } from "lucide-react";

import { ClockButtons, StopTimerButton, VisitButtons } from "./controls";
import { myDay, type Visit } from "./queries";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { requirePermission } from "@/lib/auth";
import { asStatus, JOB_STATUS_META, JOB_STATUSES, type JobStatus } from "@/lib/constants";
import { dataStaysOnThisMachine } from "@/lib/config";
import { can } from "@/lib/permissions";
import { pushKeys } from "@/lib/push";
import { formatIn, nowIn, toDateTimeLocal } from "@/lib/time-zone";
import { directionsUrl, formatMinutes } from "@/lib/utils";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "My day" };

/**
 * My Day: one person's day on one screen, made for a phone on site — the
 * clock, the timer, and today's visits with the buttons a tech reaches for.
 * The crew's home: the dashboard is the business's view, this is theirs.
 */
export default async function MyDayPage() {
  const { user, org } = await requirePermission("jobs:log-time");
  const zone = await viewerTimeZone();
  const now = new Date();
  const day = await myDay(org.id, user.id, zone, now);
  const pushOffered = !dataStaysOnThisMachine() && Boolean(pushKeys());

  const hour = nowIn(zone).getHours();
  const greeting = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const time = (date: Date) => formatIn(date, "h:mm a", zone);

  // For somebody who forgot to clock out: a guess at when they stopped, eight
  // hours after starting, to be corrected.
  const guessOut = day.clock
    ? new Date(Math.min(day.clock.clockedInAt.getTime() + 8 * 60 * 60 * 1000, now.getTime()))
    : now;

  const visitProps = (visit: Visit) => ({
    visit,
    zone,
    running: day.timer?.job.id === visit.id,
    canPhoto: can(user, "files:write"),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={`Good ${greeting}, ${user.name.split(" ")[0]}`}
        description={formatIn(now, "EEEE, MMMM d", zone)}
      />

      {/* --------------------------------------------------------- clock --- */}
      <Card>
        <div className="space-y-4 p-5">
          <div className="flex items-start gap-3">
            <span
              className={
                day.clock
                  ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/12 text-success"
                  : "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-3 text-ink-subtle"
              }
            >
              <Clock className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              {day.clock ? (
                <p className="text-base font-semibold text-ink">
                  {day.clockFromEarlier
                    ? `Still clocked in from ${formatIn(day.clock.clockedInAt, "EEE, MMM d 'at' h:mm a", zone)}`
                    : `On the clock since ${time(day.clock.clockedInAt)}`}
                </p>
              ) : (
                <p className="text-base font-semibold text-ink">Off the clock</p>
              )}
              <p className="tabular text-sm text-ink-muted">
                {day.minutesToday > 0
                  ? `${formatMinutes(day.minutesToday)} today`
                  : day.clock
                    ? "Just clocked in"
                    : "Nothing clocked today yet"}
              </p>
            </div>
          </div>

          <ClockButtons
            clockedIn={Boolean(day.clock)}
            fromEarlier={day.clockFromEarlier}
            defaultOutAt={toDateTimeLocal(guessOut, zone)}
            maxOutAt={toDateTimeLocal(now, zone)}
          />
        </div>

        {day.timer ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-line bg-brand/5 px-5 py-3">
            <Timer className="h-4 w-4 text-brand" strokeWidth={2} />
            <p className="min-w-0 flex-1 text-sm text-ink">
              Timer on{" "}
              <Link href={`/jobs/${day.timer.job.id}`} className="font-medium hover:text-brand">
                {day.timer.job.number} · {day.timer.job.title}
              </Link>{" "}
              <span className="text-ink-muted">since {time(day.timer.startedAt)}</span>
            </p>
            <StopTimerButton />
          </div>
        ) : null}
      </Card>

      {/* -------------------------------------------------------- visits --- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Today</h2>
        {day.today.length === 0 ? (
          <Card>
            <EmptyState
              icon={<CalendarCheck className="h-5 w-5" strokeWidth={1.75} />}
              title="Nothing booked for you today"
              description="Anything you are put on for today shows up here."
              action={
                <Link href="/schedule" className={buttonClasses("outline", "sm")}>
                  Open the schedule
                </Link>
              }
            />
          </Card>
        ) : (
          day.today.map((visit) => <VisitCard key={visit.id} {...visitProps(visit)} />)
        )}
      </section>

      {day.carriedOver.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-ink">Still open from before</h2>
          {day.carriedOver.map((visit) => (
            <VisitCard key={visit.id} {...visitProps(visit)} />
          ))}
        </section>
      ) : null}

      {/* Set up once, on the profile: the reminder lives where it is used. */}
      {pushOffered ? (
        <p className="text-center text-xs text-ink-subtle">
          Want a buzz when you are put on a job or your day changes?{" "}
          <Link href="/settings/profile" className="font-medium text-brand hover:underline">
            Turn on notifications
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function VisitCard({
  visit,
  zone,
  running,
  canPhoto,
}: {
  visit: Visit;
  zone: string;
  running: boolean;
  canPhoto: boolean;
}) {
  const status = asStatus(JOB_STATUSES, visit.status, "SCHEDULED") as JobStatus;
  const meta = JOB_STATUS_META[status];
  const when = !visit.scheduledStart
    ? "Not scheduled"
    : visit.allDay
      ? "All day"
      : `${formatIn(visit.scheduledStart, "h:mm a", zone)}${
          visit.scheduledEnd ? ` – ${formatIn(visit.scheduledEnd, "h:mm a", zone)}` : ""
        }`;
  const address = visit.address
    ? [visit.address.line1, visit.address.city].filter(Boolean).join(", ")
    : null;

  return (
    <Card className={running ? "border-brand/40" : undefined}>
      <CardHeader
        title={
          <Link href={`/jobs/${visit.id}`} className="hover:text-brand">
            {visit.title}
          </Link>
        }
        description={
          <span className="tabular">
            {when} · {visit.number}
            {visit.client ? ` · ${visit.client.displayName}` : ""}
          </span>
        }
        action={
          <Badge tone={running ? "info" : meta.tone} dot>
            {running ? "Timer running" : meta.label}
          </Badge>
        }
      />
      <div className="space-y-3 px-5 py-4">
        {address || visit.checklist.total > 0 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-muted">
            {address ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{address}</span>
              </span>
            ) : null}
            {visit.checklist.total > 0 ? (
              <Link href={`/jobs/${visit.id}`} className="flex items-center gap-1.5 hover:text-brand">
                <ListChecks className="h-3.5 w-3.5" strokeWidth={1.75} />
                {visit.checklist.done} of {visit.checklist.total} ticked
              </Link>
            ) : null}
          </div>
        ) : null}

        <VisitButtons
          jobId={visit.id}
          status={status}
          running={running}
          directions={visit.address ? directionsUrl(visit.address) : null}
          phone={visit.client?.phone ?? null}
          canPhoto={canPhoto}
          // The list is the person's own work, so they may finish it.
          canComplete
        />
      </div>
    </Card>
  );
}

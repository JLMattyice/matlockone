import type { Metadata } from "next";
import Link from "next/link";
import { format, isToday, isTomorrow } from "date-fns";
import {
  Banknote,
  Briefcase,
  CalendarClock,
  CheckCircle2,
  CheckSquare,
  CircleDollarSign,
  Plus,
  Scale,
  Target,
  Timer,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { loadDashboard } from "./queries";
import { taskSummary } from "../tasks/queries";
import { ActivityTimeline } from "@/components/activity/timeline";
import { CashFlowChart } from "@/components/dashboard/cash-flow-chart";
import { StatTile } from "@/components/dashboard/stat-tile";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { canSeeBusinessActivity, recentActivity } from "@/lib/activity";
import { requireContext } from "@/lib/auth";
import {
  healthBands,
  type HealthIcon,
  type HealthTile,
} from "@/lib/business-health";
import {
  asStatus,
  JOB_STATUS_META,
  JOB_STATUSES,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type PaymentMethod,
} from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const ctx = await requireContext();
  const { user, org } = ctx;
  const data = await loadDashboard(ctx);
  const tasks = await taskSummary(org.id, user);

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const firstName = user.name.split(" ")[0];

  const health = healthBands({
    seesMoney: data.seesMoney,
    seesExpenses: data.seesExpenses,
    seesPipeline: data.seesPipeline,
    collectedCents: data.revenueThisMonthCents,
    spentCents: data.spentThisMonthCents,
    outstandingCents: data.outstandingCents,
    outstandingCount: data.outstandingCount,
    overdueCents: data.overdueCents,
    overdueCount: data.overdueCount,
    pipelineCount: data.pipelineCount,
    pipelineValueCents: data.pipelineValueCents,
    activeWork: data.activeWork,
    completedThisMonth: data.completedThisMonth,
    tasksDueToday: tasks.dueToday,
    tasksOverdue: tasks.overdue,
    labels: { jobPlural: org.labelJobPlural, leadPlural: org.labelLeadPlural },
    money,
    monthLabel: format(new Date(), "MMMM yyyy"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Good ${partOfDay()}, ${firstName}`}
        description={`Here is where ${org.name} stands today.`}
        actions={<QuickActions ctx={ctx} />}
      />

      {/* Two questions, in the order an owner asks them: how is the money,
          and how is the work. Each band shows only what this person may see,
          which healthBands() decides — an employee gets the work band alone. */}
      {health.money.length > 0 ? (
        <HealthBand title="Money this month" tiles={health.money} />
      ) : null}

      <HealthBand title="Work" tiles={health.work} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Upcoming"
            description="Scheduled over the next seven days"
            action={
              <Link href="/schedule" className={buttonClasses("ghost", "sm")}>
                Open schedule
              </Link>
            }
          />
          {data.upcoming.length === 0 ? (
            <EmptyState
              icon={<CalendarClock className="h-5 w-5" strokeWidth={1.75} />}
              title="Nothing scheduled this week"
              description={`New ${org.labelJobPlural.toLowerCase()} and appointments will appear here.`}
            />
          ) : (
            <ul className="divide-y divide-line">
              {data.upcoming.map((job) => (
                <li
                  key={job.id}
                  className="flex items-start gap-4 px-5 py-3.5 transition-colors hover:bg-surface-2"
                >
                  <div className="w-15 shrink-0 text-center">
                    <p className="text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase">
                      {job.scheduledStart ? whenLabel(job.scheduledStart) : "—"}
                    </p>
                    <p className="tabular text-sm font-semibold text-ink">
                      {job.scheduledStart
                        ? job.allDay
                          ? "All day"
                          : format(job.scheduledStart, "h:mm a")
                        : ""}
                    </p>
                  </div>

                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/jobs/${job.id}`}
                      className="truncate text-sm font-medium text-ink transition-colors hover:text-brand"
                    >
                      {job.title}
                    </Link>
                    <p className="truncate text-xs text-ink-muted">
                      {[
                        job.client?.displayName,
                        job.address
                          ? [job.address.line1, job.address.city]
                              .filter(Boolean)
                              .join(", ")
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") ||
                        `No ${org.labelClientSingular.toLowerCase()} attached`}
                    </p>
                    {job.assignments.length ? (
                      <p className="mt-1 truncate text-xs text-ink-subtle">
                        {job.assignments.map((a) => a.user.name).join(", ")}
                      </p>
                    ) : null}
                  </div>

                  <JobStatusBadge status={job.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="In progress" description="On site now" />
          {data.inProgress.length === 0 ? (
            <EmptyState
              icon={<Timer className="h-5 w-5" strokeWidth={1.75} />}
              title="No active work"
              description={`Anything marked In Progress shows up here.`}
            />
          ) : (
            <ul className="divide-y divide-line">
              {data.inProgress.map((job) => (
                <li key={job.id} className="px-5 py-3.5">
                  <Link
                    href={`/jobs/${job.id}`}
                    className="block truncate text-sm font-medium text-ink transition-colors hover:text-brand"
                  >
                    {job.title}
                  </Link>
                  <p className="truncate text-xs text-ink-muted">
                    {job.client?.displayName ?? "No client"}
                  </p>
                  <p className="mt-1 text-xs text-ink-subtle">
                    {job.startedAt
                      ? `Started ${format(job.startedAt, "h:mm a")}`
                      : "Not started"}
                    {job.assignments.length
                      ? ` · ${job.assignments.map((a) => a.user.name).join(", ")}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {data.seesMoney ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title={data.seesExpenses ? "Money in and out" : "Revenue"}
              description={
                data.seesExpenses
                  ? "Payments received against expenses recorded, over the last six months"
                  : "Payments received over the last six months"
              }
            />
            <div className="p-5">
              <CashFlowChart
                buckets={data.monthlyCashFlow}
                currency={org.currency}
                locale={org.locale}
                showSpend={data.seesExpenses}
              />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Recent payments"
              action={
                <Link href="/payments" className={buttonClasses("ghost", "sm")}>
                  All
                </Link>
              }
            />
            {data.recentPayments.length === 0 ? (
              <EmptyState
                icon={<Wallet className="h-5 w-5" strokeWidth={1.75} />}
                title="No payments recorded"
              />
            ) : (
              <ul className="divide-y divide-line">
                {data.recentPayments.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex items-center justify-between gap-3 px-5 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">
                        {payment.client?.displayName ?? "Payment"}
                      </p>
                      <p className="truncate text-xs text-ink-subtle">
                        {payment.invoice?.number ?? "—"} ·{" "}
                        {methodLabel(payment.method)} ·{" "}
                        {format(payment.receivedAt, "MMM d")}
                      </p>
                    </div>
                    <span className="tabular shrink-0 text-sm font-semibold text-success">
                      {money(payment.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}

      {/* What the business actually did lately — the timeline across every
          client, which is the part of the dashboard that changes every day. */}
      {canSeeBusinessActivity(user) ? (
        <Card>
          <CardHeader
            title="Recent activity"
            description="Across the whole business"
          />
          <ActivityTimeline
            events={await recentActivity(org.id, user, 8)}
            emptyTitle="Nothing has happened yet"
            emptyDescription="Sent documents, payments, finished work and completed tasks will show up here."
          />
        </Card>
      ) : null}

      {data.seesExpenses && data.reimbursementsOwed.length > 0 ? (
        <Card>
          <CardHeader
            title="Owed back to the team"
            description="Expenses someone paid for out of pocket and has not been repaid for"
            action={
              <Link
                href="/expenses?flag=unreimbursed&period=all"
                className={buttonClasses("ghost", "sm")}
              >
                View all
              </Link>
            }
          />

          <div className="flex flex-wrap items-baseline gap-x-2 border-b border-line px-5 py-3">
            <span className="tabular text-lg font-semibold text-ink">
              {money(data.reimbursementsOwedCents)}
            </span>
            <span className="text-xs text-ink-muted">
              across {data.reimbursementsOwedCount}{" "}
              {plural(data.reimbursementsOwedCount, "expense")}, oldest first
            </span>
          </div>

          <ul className="divide-y divide-line">
            {data.reimbursementsOwed.map((expense) => (
              <li
                key={expense.id}
                className="flex items-center justify-between gap-4 px-5 py-3"
              >
                <div className="min-w-0">
                  <Link
                    href={`/expenses/${expense.id}`}
                    className="block truncate text-sm font-medium text-ink transition-colors hover:text-brand"
                  >
                    {expense.description}
                  </Link>
                  <p className="truncate text-xs text-ink-subtle">
                    {expense.paidBy?.name ?? "Unassigned"} ·{" "}
                    {format(expense.spentAt, "MMM d, yyyy")}
                    {expense.vendor ? ` · ${expense.vendor}` : ""}
                  </p>
                </div>
                <span className="tabular shrink-0 text-sm font-semibold text-ink">
                  {money(expense.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {data.seesMoney && data.overdueInvoices.length > 0 ? (
        <Card>
          <CardHeader
            title="Overdue invoices"
            description="Past their due date and still carrying a balance"
            action={
              <Link href="/invoices" className={buttonClasses("ghost", "sm")}>
                View all
              </Link>
            }
          />
          <ul className="divide-y divide-line">
            {data.overdueInvoices.map((invoice) => (
              <li
                key={invoice.id}
                className="flex items-center justify-between gap-4 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {invoice.number} · {invoice.client.displayName}
                  </p>
                  <p className="text-xs text-danger">
                    Due {invoice.dueDate ? format(invoice.dueDate, "MMM d, yyyy") : "—"}
                    {invoice.dueDate ? ` · ${daysLate(invoice.dueDate)} days late` : ""}
                  </p>
                </div>
                <span className="tabular shrink-0 text-sm font-semibold text-ink">
                  {money(invoice.balanceCents)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function QuickActions({ ctx }: { ctx: Awaited<ReturnType<typeof requireContext>> }) {
  const actions = [
    {
      href: "/jobs/new",
      label: `New ${ctx.org.labelJobSingular.toLowerCase()}`,
      permission: "jobs:write" as const,
    },
    {
      href: "/estimates/new",
      label: `New ${ctx.org.labelEstimateSingular.toLowerCase()}`,
      permission: "estimates:write" as const,
    },
    { href: "/invoices/new", label: "New invoice", permission: "invoices:write" as const },
    { href: "/clients/new", label: `New ${ctx.org.labelClientSingular.toLowerCase()}`, permission: "clients:write" as const },
  ].filter((action) => can(ctx.user, action.permission));

  if (actions.length === 0) return null;

  return (
    <>
      {actions.map((action, i) => (
        <Link
          key={action.href}
          href={action.href}
          className={buttonClasses(i === 0 ? "primary" : "outline", "md")}
        >
          {i === 0 ? <Plus className="h-4 w-4" strokeWidth={2} /> : null}
          {action.label}
        </Link>
      ))}
    </>
  );
}

function JobStatusBadge({ status }: { status: string }) {
  const meta = JOB_STATUS_META[asStatus(JOB_STATUSES, status, "SCHEDULED")];
  return (
    <Badge tone={meta.tone} className="mt-0.5 shrink-0">
      {meta.label}
    </Badge>
  );
}

function methodLabel(method: string) {
  return PAYMENT_METHOD_LABELS[
    asStatus(PAYMENT_METHODS, method, "OTHER") as PaymentMethod
  ];
}

function whenLabel(date: Date) {
  if (isToday(date)) return "Today";
  if (isTomorrow(date)) return "Tomorrow";
  return format(date, "EEE d");
}

function daysLate(dueDate: Date) {
  return Math.max(
    Math.floor((Date.now() - dueDate.getTime()) / (1000 * 60 * 60 * 24)),
    0,
  );
}

function plural(count: number, word: string) {
  return count === 1 ? word : `${word}s`;
}

function partOfDay() {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

const HEALTH_ICONS: Record<HealthIcon, LucideIcon> = {
  collected: CircleDollarSign,
  spent: Banknote,
  net: Scale,
  outstanding: Wallet,
  pipeline: Target,
  work: Briefcase,
  tasks: CheckSquare,
  completed: CheckCircle2,
};

/**
 * One row of tiles under a small heading.
 *
 * The grid is sized from the tile count, because a band of three tiles in four
 * columns leaves a hole at the end that reads as something failing to load.
 */
function HealthBand({ title, tiles }: { title: string; tiles: HealthTile[] }) {
  if (tiles.length === 0) return null;

  const columns =
    tiles.length >= 4
      ? "sm:grid-cols-2 xl:grid-cols-4"
      : tiles.length === 3
        ? "sm:grid-cols-3"
        : "sm:grid-cols-2";

  return (
    <section>
      <h2 className="mb-2.5 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
        {title}
      </h2>
      <div className={cn("grid gap-4", columns)}>
        {tiles.map((tile) => (
          <StatTile
            key={tile.key}
            label={tile.label}
            value={tile.value}
            sublabel={tile.sublabel}
            icon={HEALTH_ICONS[tile.icon]}
            tone={tile.tone}
            href={tile.href}
          />
        ))}
      </div>
    </section>
  );
}

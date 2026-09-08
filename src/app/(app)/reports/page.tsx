import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowDownRight,
  ArrowUpRight,
  Download,
  Minus,
} from "lucide-react";

import {
  cashFlowSeries,
  expenseTotals,
  isReportPeriod,
  leadSourcePerformance,
  PERIOD_LABELS,
  periodTotals,
  receivablesSnapshot,
  REPORT_PERIODS,
  resolveRange,
  revenueByEmployee,
  revenueByService,
  spendByCategory,
  spendByVendor,
  topClients,
  type ReportPeriod,
} from "./queries";
import { ShareBar, TrendChart } from "@/components/reports/trend-chart";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import { LEAD_SOURCE_LABELS, LEAD_SOURCES, type LeadSource } from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { user, org } = await requirePermission("reports:read");
  const params = await searchParams;

  // Reports and expenses are separate permissions. Every role that can open
  // this page can see spend today, but the page must not be the thing that
  // decides that — otherwise granting reports quietly grants the books too.
  const showSpend = can(user, "expenses:read");

  const period: ReportPeriod = isReportPeriod(params.period)
    ? params.period
    : "month";
  const { current, previous, granularity } = resolveRange(period);

  const [
    totals,
    priorTotals,
    series,
    services,
    employees,
    sources,
    clients,
    receivables,
    spend,
    priorSpend,
    categories,
    vendors,
  ] = await Promise.all([
    periodTotals(org.id, current),
    periodTotals(org.id, previous),
    cashFlowSeries(org.id, current, granularity),
    revenueByService(org.id, current),
    revenueByEmployee(org.id, current),
    leadSourcePerformance(org.id, current),
    topClients(org.id, current),
    receivablesSnapshot(org.id),
    showSpend ? expenseTotals(org.id, current) : null,
    showSpend ? expenseTotals(org.id, previous) : null,
    showSpend ? spendByCategory(org.id, current) : [],
    showSpend ? spendByVendor(org.id, current) : [],
  ]);

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);

  // Cash movement, not profit — see the caption on the card that shows it.
  const netCents = spend ? totals.collectedCents - spend.spentCents : 0;
  const priorNetCents = priorSpend
    ? priorTotals.collectedCents - priorSpend.spentCents
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description={`${format(current.from, "MMM d, yyyy")} – ${format(current.to, "MMM d, yyyy")}`}
        actions={
          <a
            href={`/reports/export?period=${period}`}
            className={buttonClasses("outline", "md")}
          >
            <Download className="h-3.5 w-3.5" strokeWidth={2} />
            Export CSV
          </a>
        }
      />

      <div className="flex flex-wrap gap-1 rounded-lg border border-line p-0.5">
        {REPORT_PERIODS.map((option) => (
          <Link
            key={option}
            href={`/reports?period=${option}`}
            aria-current={period === option ? "page" : undefined}
            className={
              period === option
                ? "rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink"
                : "rounded-md px-3 py-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
            }
          >
            {PERIOD_LABELS[option]}
          </Link>
        ))}
      </div>

      {/* --------------------------------------------------------- headline --- */}
      <div
        className={cn(
          "grid gap-4 sm:grid-cols-2",
          spend ? "lg:grid-cols-3" : "xl:grid-cols-4",
        )}
      >
        <Metric
          label="Collected"
          value={money(totals.collectedCents)}
          current={totals.collectedCents}
          prior={priorTotals.collectedCents}
          priorLabel={previous.label}
          sub={`${totals.paymentCount} payment${totals.paymentCount === 1 ? "" : "s"}`}
        />
        {spend ? (
          <>
            <Metric
              label="Spent"
              value={money(spend.spentCents)}
              current={spend.spentCents}
              prior={priorSpend?.spentCents ?? 0}
              priorLabel={previous.label}
              sub={`${spend.expenseCount} expense${spend.expenseCount === 1 ? "" : "s"}`}
              // More money going out is not the good direction.
              invertTrend
            />
            <Metric
              label="Net cash"
              value={money(netCents)}
              current={netCents}
              prior={priorNetCents}
              priorLabel={previous.label}
              sub="Collected less spent"
              tone={netCents < 0 ? "danger" : undefined}
            />
          </>
        ) : null}
        <Metric
          label="Invoiced"
          value={money(totals.invoicedCents)}
          current={totals.invoicedCents}
          prior={priorTotals.invoicedCents}
          priorLabel={previous.label}
          sub={`${totals.invoiceCount} invoice${totals.invoiceCount === 1 ? "" : "s"}`}
        />
        <Metric
          label={`${org.labelJobPlural} completed`}
          value={String(totals.jobsCompleted)}
          current={totals.jobsCompleted}
          prior={priorTotals.jobsCompleted}
          priorLabel={previous.label}
        />
        <Metric
          label="Active clients"
          value={String(totals.activeClients)}
          current={totals.activeClients}
          prior={priorTotals.activeClients}
          priorLabel={previous.label}
          sub={`${totals.newClients} new`}
        />
      </div>

      <Card>
        <CardHeader
          title={spend ? "Money in and out" : "Revenue"}
          description={
            spend
              ? "Payments received against expenses recorded. Money billed in a period is not money that arrived in it — see Invoiced above."
              : "Payments received. Money billed in a period is not money that arrived in it — see Invoiced above."
          }
        />
        <div className="p-5">
          <TrendChart
            buckets={series}
            currency={org.currency}
            locale={org.locale}
            showSpend={Boolean(spend)}
          />
        </div>
      </Card>

      {/* ---------------------------------------------------------- spend --- */}
      {spend ? (
        <Card>
          <CardHeader
            title="Spending"
            description="Cash movement, not profit: it counts only what has been recorded here, and nothing is accrued or depreciated."
            action={
              <Link href="/expenses" className={buttonClasses("ghost", "sm")}>
                Open expenses
              </Link>
            }
          />
          <div className="grid grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
            <Figure
              label={`${org.labelJobSingular} costs`}
              value={money(spend.jobCostCents)}
              hint={`${spend.jobCostCount} booked to a ${org.labelJobSingular.toLowerCase()}`}
            />
            <Figure
              label="Overhead"
              value={money(spend.overheadCents)}
              hint="Not tied to one piece of work"
            />
            <Figure
              label="Recoverable tax"
              value={money(spend.taxCents)}
              hint="Included in the totals above"
            />
            <Figure
              label="Owed back"
              value={money(spend.unreimbursedCents)}
              tone={spend.unreimbursedCents > 0 ? "danger" : "success"}
              hint={
                spend.unreimbursedCount > 0
                  ? `${spend.unreimbursedCount} unsettled, all time`
                  : "Nothing outstanding"
              }
            />
          </div>
        </Card>
      ) : null}

      {/* ------------------------------------------------------ receivables --- */}
      <Card>
        <CardHeader
          title="Receivables"
          description="As of today, not the selected period."
          action={
            <Link href="/invoices" className={buttonClasses("ghost", "sm")}>
              Open invoices
            </Link>
          }
        />
        <div className="grid grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
          <Figure label="Outstanding" value={money(receivables.outstandingCents)} />
          <Figure
            label="Overdue"
            value={money(receivables.overdueCents)}
            tone={receivables.overdueCents > 0 ? "danger" : "success"}
          />
          <Figure label="Open invoices" value={String(receivables.openCount)} />
          <Figure
            label="Average invoice"
            value={money(totals.averageInvoiceCents)}
          />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ----------------------------------------------------- services --- */}
        <Card className="overflow-hidden">
          <CardHeader
            title="Top services"
            description="By amount invoiced in this period"
          />
          {services.length === 0 ? (
            <Empty />
          ) : (
            <Table>
              <THead>
                <Th>Service</Th>
                <Th align="right">Times billed</Th>
                <Th align="right">Invoiced</Th>
              </THead>
              <TBody>
                {services.map((service) => (
                  <Tr key={service.name}>
                    <Td>
                      <span className="block truncate font-medium">
                        {service.name}
                      </span>
                      <ShareBar
                        value={service.totalCents}
                        peak={services[0].totalCents}
                      />
                    </Td>
                    <Td align="right" className="tabular text-ink-muted">
                      {service.count}
                    </Td>
                    <Td align="right" className="tabular font-medium whitespace-nowrap">
                      {money(service.totalCents)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        {/* ------------------------------------------------------ clients --- */}
        <Card className="overflow-hidden">
          <CardHeader
            title="Top clients"
            description="By amount invoiced in this period"
          />
          {clients.length === 0 ? (
            <Empty />
          ) : (
            <Table>
              <THead>
                <Th>Client</Th>
                <Th align="right">Invoices</Th>
                <Th align="right">Invoiced</Th>
              </THead>
              <TBody>
                {clients.map((client) => (
                  <Tr key={client.clientId}>
                    <Td>
                      <Link
                        href={`/clients/${client.clientId}`}
                        className="block truncate font-medium text-ink transition-colors hover:text-brand"
                      >
                        {client.name}
                      </Link>
                      <ShareBar
                        value={client.invoicedCents}
                        peak={clients[0].invoicedCents}
                      />
                    </Td>
                    <Td align="right" className="tabular text-ink-muted">
                      {client.invoiceCount}
                    </Td>
                    <Td align="right" className="tabular font-medium whitespace-nowrap">
                      {money(client.invoicedCents)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        {/* ----------------------------------------------------- employees --- */}
        <Card className="overflow-hidden">
          <CardHeader
            title="Labor by person"
            description="Hours logged in this period"
          />
          {employees.length === 0 ? (
            <Empty />
          ) : (
            <Table>
              <THead>
                <Th>Person</Th>
                <Th align="right">Hours</Th>
                <Th align="right">Billable value</Th>
              </THead>
              <TBody>
                {employees.map((person) => (
                  <Tr key={person.id}>
                    <Td>
                      <Link
                        href={`/team/${person.id}`}
                        className="block truncate font-medium text-ink transition-colors hover:text-brand"
                      >
                        {person.name}
                      </Link>
                      <ShareBar
                        value={person.minutes}
                        peak={employees[0].minutes}
                      />
                    </Td>
                    <Td align="right" className="tabular whitespace-nowrap">
                      {(person.minutes / 60).toFixed(1)}h
                    </Td>
                    <Td align="right" className="tabular font-medium whitespace-nowrap">
                      {money(person.billableCents)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        {/* ------------------------------------------------ spend by kind --- */}
        {spend ? (
          <Card className="overflow-hidden">
            <CardHeader
              title="Where the money went"
              description="By category in this period"
            />
            {categories.length === 0 ? (
              <Empty />
            ) : (
              <Table>
                <THead>
                  <Th>Category</Th>
                  <Th align="right">Expenses</Th>
                  <Th align="right">Spent</Th>
                </THead>
                <TBody>
                  {categories.map((row) => (
                    <Tr key={row.category}>
                      <Td>
                        <Link
                          href={`/expenses?category=${row.category}`}
                          className="block truncate font-medium text-ink transition-colors hover:text-brand"
                        >
                          {row.label}
                        </Link>
                        <ShareBar
                          value={row.totalCents}
                          peak={categories[0].totalCents}
                          tone="warning"
                        />
                      </Td>
                      <Td align="right" className="tabular text-ink-muted">
                        {row.count}
                      </Td>
                      <Td align="right" className="tabular font-medium whitespace-nowrap">
                        {money(row.totalCents)}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        ) : null}

        {/* ---------------------------------------------------- top vendors --- */}
        {spend ? (
          <Card className="overflow-hidden">
            <CardHeader
              title="Top vendors"
              description="By amount spent in this period"
            />
            {vendors.length === 0 ? (
              <Empty />
            ) : (
              <Table>
                <THead>
                  <Th>Vendor</Th>
                  <Th align="right">Expenses</Th>
                  <Th align="right">Spent</Th>
                </THead>
                <TBody>
                  {vendors.map((row) => (
                    <Tr key={row.vendor}>
                      <Td>
                        <span className="block truncate font-medium">
                          {row.vendor}
                        </span>
                        <ShareBar
                          value={row.totalCents}
                          peak={vendors[0].totalCents}
                          tone="warning"
                        />
                      </Td>
                      <Td align="right" className="tabular text-ink-muted">
                        {row.count}
                      </Td>
                      <Td align="right" className="tabular font-medium whitespace-nowrap">
                        {money(row.totalCents)}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        ) : null}

        {/* -------------------------------------------------- lead sources --- */}
        <Card className="overflow-hidden">
          <CardHeader
            title="Where work came from"
            description="Leads created in this period"
          />
          {sources.length === 0 ? (
            <Empty />
          ) : (
            <Table>
              <THead>
                <Th>Source</Th>
                <Th align="right">Leads</Th>
                <Th align="right">Won</Th>
                <Th align="right">Rate</Th>
              </THead>
              <TBody>
                {sources.map((source) => (
                  <Tr key={source.source}>
                    <Td>
                      <span className="block font-medium">
                        {LEAD_SOURCES.includes(source.source as LeadSource)
                          ? LEAD_SOURCE_LABELS[source.source as LeadSource]
                          : "Not recorded"}
                      </span>
                      <ShareBar value={source.total} peak={sources[0].total} />
                    </Td>
                    <Td align="right" className="tabular text-ink-muted">
                      {source.total}
                    </Td>
                    <Td align="right" className="tabular font-medium">
                      {source.won}
                    </Td>
                    <Td align="right" className="tabular whitespace-nowrap">
                      {source.total > 0
                        ? `${Math.round((source.won / source.total) * 100)}%`
                        : "—"}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  current,
  prior,
  priorLabel,
  invertTrend = false,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  current: number;
  prior: number;
  priorLabel: string;
  /** For figures where up is the bad direction, such as money going out. */
  invertTrend?: boolean;
  tone?: "danger";
}) {
  // With no baseline, a percentage would be meaningless rather than infinite.
  const delta = prior > 0 ? ((current - prior) / prior) * 100 : null;
  const rising = delta !== null && delta > 0.5;
  const falling = delta !== null && delta < -0.5;
  const good = invertTrend ? falling : rising;
  const bad = invertTrend ? rising : falling;

  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-xs">
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p
        className={cn(
          "tabular mt-1.5 text-2xl font-semibold tracking-tight",
          tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {value}
      </p>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
        <span
          className={cn(
            "inline-flex items-center gap-0.5 font-medium",
            good ? "text-success" : bad ? "text-danger" : "text-ink-subtle",
          )}
        >
          {delta === null ? (
            <>
              <Minus className="h-3 w-3" strokeWidth={2.5} />
              No baseline
            </>
          ) : (
            <>
              {rising ? (
                <ArrowUpRight className="h-3 w-3" strokeWidth={2.5} />
              ) : falling ? (
                <ArrowDownRight className="h-3 w-3" strokeWidth={2.5} />
              ) : (
                <Minus className="h-3 w-3" strokeWidth={2.5} />
              )}
              {Math.abs(delta).toFixed(0)}%
            </>
          )}
        </span>
        <span className="text-ink-subtle">vs {priorLabel.toLowerCase()}</span>
      </div>

      {sub ? <p className="mt-0.5 text-xs text-ink-subtle">{sub}</p> : null}
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "success" | "danger";
  hint?: string;
}) {
  return (
    <div className="px-5 py-3.5">
      <p className="text-xs text-ink-muted">{label}</p>
      <p
        className={cn(
          "tabular mt-0.5 text-lg font-semibold",
          tone === "success"
            ? "text-success"
            : tone === "danger"
              ? "text-danger"
              : "text-ink",
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-ink-subtle">{hint}</p> : null}
    </div>
  );
}

function Empty() {
  return (
    <p className="px-5 py-8 text-center text-sm text-ink-subtle">
      Nothing in this period.
    </p>
  );
}

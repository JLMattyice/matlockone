import { NextResponse, type NextRequest } from "next/server";
import { format } from "date-fns";

import {
  cashFlowSeries,
  expenseTotals,
  isReportPeriod,
  leadSourcePerformance,
  periodTotals,
  receivablesSnapshot,
  resolveRange,
  revenueByEmployee,
  revenueByService,
  spendByCategory,
  spendByVendor,
  topClients,
  type ReportPeriod,
} from "../queries";
import { getContext } from "@/lib/auth";
import { LEAD_SOURCE_LABELS, LEAD_SOURCES, type LeadSource } from "@/lib/constants";
import { can } from "@/lib/permissions";

/**
 * The report as a CSV any spreadsheet can open.
 *
 * Money is written as a plain decimal ("1234.56") rather than a formatted
 * string, so the numbers arrive as numbers and stay summable.
 */
export async function GET(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx || !can(ctx.user, "reports:read")) {
    return new NextResponse("Not found", { status: 404 });
  }

  const periodParam = request.nextUrl.searchParams.get("period");
  const period: ReportPeriod = isReportPeriod(periodParam)
    ? periodParam
    : "month";

  const { current, previous, granularity } = resolveRange(period);
  const orgId = ctx.org.id;

  // Spend is a separate permission, and the export must honour it as the page
  // does — a CSV is the easiest way for a figure to escape the role that hid it.
  const showSpend = can(ctx.user, "expenses:read");

  const [
    totals,
    prior,
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
    periodTotals(orgId, current),
    periodTotals(orgId, previous),
    cashFlowSeries(orgId, current, granularity),
    revenueByService(orgId, current),
    revenueByEmployee(orgId, current),
    leadSourcePerformance(orgId, current),
    topClients(orgId, current, 25),
    receivablesSnapshot(orgId),
    showSpend ? expenseTotals(orgId, current) : null,
    showSpend ? expenseTotals(orgId, previous) : null,
    showSpend ? spendByCategory(orgId, current, 100) : [],
    showSpend ? spendByVendor(orgId, current, 100) : [],
  ]);

  const money = (cents: number) => (cents / 100).toFixed(2);
  const rows: string[][] = [];

  rows.push([ctx.org.name, "Report", current.label]);
  rows.push([
    "Period",
    format(current.from, "yyyy-MM-dd"),
    format(current.to, "yyyy-MM-dd"),
  ]);
  rows.push([]);

  rows.push(["Summary", "This period", previous.label]);
  rows.push(["Collected", money(totals.collectedCents), money(prior.collectedCents)]);
  rows.push(["Invoiced", money(totals.invoicedCents), money(prior.invoicedCents)]);
  rows.push(["Payments", String(totals.paymentCount), String(prior.paymentCount)]);
  rows.push(["Invoices", String(totals.invoiceCount), String(prior.invoiceCount)]);
  rows.push([
    "Jobs completed",
    String(totals.jobsCompleted),
    String(prior.jobsCompleted),
  ]);
  rows.push([
    "Active clients",
    String(totals.activeClients),
    String(prior.activeClients),
  ]);
  rows.push(["New clients", String(totals.newClients), String(prior.newClients)]);
  rows.push(["Average invoice", money(totals.averageInvoiceCents), ""]);

  if (spend && priorSpend) {
    rows.push(["Spent", money(spend.spentCents), money(priorSpend.spentCents)]);
    rows.push([
      "Expenses",
      String(spend.expenseCount),
      String(priorSpend.expenseCount),
    ]);
    rows.push([
      "Net cash (collected less spent)",
      money(totals.collectedCents - spend.spentCents),
      money(prior.collectedCents - priorSpend.spentCents),
    ]);
    rows.push([
      "Job costs",
      money(spend.jobCostCents),
      money(priorSpend.jobCostCents),
    ]);
    rows.push([
      "Overhead",
      money(spend.overheadCents),
      money(priorSpend.overheadCents),
    ]);
    rows.push(["Recoverable tax", money(spend.taxCents), money(priorSpend.taxCents)]);
    rows.push(["Owed back (all time)", money(spend.unreimbursedCents), ""]);
  }

  rows.push([]);

  rows.push(["Receivables (as of today)"]);
  rows.push(["Outstanding", money(receivables.outstandingCents)]);
  rows.push(["Overdue", money(receivables.overdueCents)]);
  rows.push(["Open invoices", String(receivables.openCount)]);
  rows.push(["Overdue invoices", String(receivables.overdueCount)]);
  rows.push([]);

  rows.push([spend ? "Money in and out over time" : "Revenue over time"]);
  rows.push(spend ? ["Date", "Collected", "Spent"] : ["Date", "Collected"]);
  for (const bucket of series) {
    const row = [format(bucket.date, "yyyy-MM-dd"), money(bucket.inCents)];
    if (spend) row.push(money(bucket.outCents));
    rows.push(row);
  }
  rows.push([]);

  rows.push(["Top services"]);
  rows.push(["Service", "Kind", "Times billed", "Invoiced"]);
  for (const service of services) {
    rows.push([
      service.name,
      service.kind,
      String(service.count),
      money(service.totalCents),
    ]);
  }
  rows.push([]);

  rows.push(["Top clients"]);
  rows.push(["Client", "Invoices", "Invoiced"]);
  for (const client of clients) {
    rows.push([
      client.name,
      String(client.invoiceCount),
      money(client.invoicedCents),
    ]);
  }
  rows.push([]);

  rows.push(["Labor by person"]);
  rows.push(["Person", "Hours", "Billable value"]);
  for (const person of employees) {
    rows.push([
      person.name,
      (person.minutes / 60).toFixed(2),
      money(person.billableCents),
    ]);
  }
  rows.push([]);

  if (spend) {
    rows.push(["Spend by category"]);
    rows.push(["Category", "Expenses", "Spent"]);
    for (const row of categories) {
      rows.push([row.label, String(row.count), money(row.totalCents)]);
    }
    rows.push([]);

    rows.push(["Spend by vendor"]);
    rows.push(["Vendor", "Expenses", "Spent"]);
    for (const row of vendors) {
      rows.push([row.vendor, String(row.count), money(row.totalCents)]);
    }
    rows.push([]);
  }

  rows.push(["Lead sources"]);
  rows.push(["Source", "Leads", "Won", "Win rate"]);
  for (const source of sources) {
    rows.push([
      LEAD_SOURCES.includes(source.source as LeadSource)
        ? LEAD_SOURCE_LABELS[source.source as LeadSource]
        : "Not recorded",
      String(source.total),
      String(source.won),
      source.total > 0
        ? `${Math.round((source.won / source.total) * 100)}%`
        : "",
    ]);
  }

  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const filename = `${slug(ctx.org.name)}-report-${period}-${format(new Date(), "yyyy-MM-dd")}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Quotes a cell for CSV. A leading =, +, - or @ is prefixed with a single
 * quote: spreadsheet software would otherwise treat the value as a formula,
 * which is how a client name becomes code execution on someone's machine.
 */
function csvCell(value: string) {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "report"
  );
}

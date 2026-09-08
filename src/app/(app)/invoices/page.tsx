import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { Plus, Receipt } from "lucide-react";

import { invoiceSummary, listInvoices } from "./queries";
import { reminderCandidateCount } from "./reminders";
import { SendReminders } from "./send-reminders";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import { INVOICE_STATUS_META, INVOICE_STATUSES } from "@/lib/constants";
import { effectiveInvoiceStatus } from "@/lib/documents";
import { formatMoney } from "@/lib/money";
import {
  InvoiceSelection,
  SelectAllInvoices,
  SelectInvoice,
} from "./selection";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Invoices" };

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    clientId?: string;
    page?: string;
  }>;
}) {
  const { user, org } = await requirePermission("invoices:read");
  const params = await searchParams;

  const [list, summary, chaseCount] = await Promise.all([
    listInvoices({
      organizationId: org.id,
      q: params.q,
      status: params.status,
      clientId: params.clientId,
      page: Number(params.page) || 1,
    }),
    invoiceSummary(org.id),
    can(user, "invoices:send") ? reminderCandidateCount() : Promise.resolve(0),
  ]);

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const writable = can(user, "invoices:write");
  const deletable = can(user, "invoices:delete");
  const isFiltered = Boolean(params.q || params.status || params.clientId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Invoices"
        description={`${money(summary.outstandingCents)} outstanding across ${summary.openCount} invoice${summary.openCount === 1 ? "" : "s"}`}
        actions={
          <>
            {can(user, "invoices:send") ? (
              <SendReminders candidates={chaseCount} />
            ) : null}
            {writable ? (
              <Link href="/invoices/new" className={buttonClasses("primary", "md")}>
                <Plus className="h-4 w-4" strokeWidth={2} />
                New invoice
              </Link>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Outstanding" value={money(summary.outstandingCents)} sub={`${summary.openCount} open`} />
        <Stat
          label="Overdue"
          value={money(summary.overdueCents)}
          sub={
            summary.overdueCount
              ? `${summary.overdueCount} past due`
              : "Nothing past due"
          }
          tone={summary.overdueCents > 0 ? "danger" : "success"}
        />
        <Stat
          label="Collected this month"
          value={money(summary.collectedThisMonthCents)}
          sub={format(new Date(), "MMMM yyyy")}
          tone="success"
        />
        <Stat label="Drafts" value={String(summary.draftCount)} sub="Not sent yet" />
      </div>

      {summary.outstandingCents > 0 ? (
        <Card>
          <div className="grid grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
            {(
              [
                ["Current", summary.buckets.current, "text-ink"],
                ["1–30 days", summary.buckets["1-30"], "text-warning"],
                ["31–60 days", summary.buckets["31-60"], "text-warning"],
                ["60+ days", summary.buckets["60+"], "text-danger"],
              ] as const
            ).map(([label, cents, tone]) => (
              <div key={label} className="px-5 py-3.5">
                <p className="text-xs text-ink-muted">{label}</p>
                <p className={cn("tabular mt-0.5 text-lg font-semibold", tone)}>
                  {money(cents)}
                </p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <ListToolbar
        searchPlaceholder="Search number, client, job or line item…"
        filters={[
          {
            name: "status",
            label: "statuses",
            options: INVOICE_STATUSES.map((status) => ({
              value: status,
              label: INVOICE_STATUS_META[status].label,
            })),
          },
        ]}
      />

      <Card className="overflow-hidden">
        {list.rows.length === 0 ? (
          <EmptyState
            icon={<Receipt className="h-5 w-5" strokeWidth={1.75} />}
            title={isFiltered ? "No matches" : "No invoices yet"}
            description={
              isFiltered
                ? "Try a different search or clear the filters."
                : "Bill a completed job, or raise an invoice from scratch."
            }
            action={
              !isFiltered && writable ? (
                <Link
                  href="/invoices/new"
                  className={buttonClasses("primary", "md")}
                >
                  <Plus className="h-4 w-4" strokeWidth={2} />
                  New invoice
                </Link>
              ) : null
            }
          />
        ) : (
          <InvoiceSelection canDelete={deletable}>
            <Table>
              <THead>
                {deletable ? (
                  <Th className="w-9">
                    <SelectAllInvoices ids={list.rows.map((row) => row.id)} />
                  </Th>
                ) : null}
                <Th>Number</Th>
                <Th>Client</Th>
                <Th className="hidden lg:table-cell">Issued</Th>
                <Th className="hidden sm:table-cell">Due</Th>
                <Th align="right">Total</Th>
                <Th align="right">Balance</Th>
                <Th>Status</Th>
              </THead>

              <TBody>
                {list.rows.map((invoice) => {
                  const status = effectiveInvoiceStatus(invoice);
                  const meta = INVOICE_STATUS_META[status];
                  const overdue = status === "OVERDUE";

                  return (
                    <Tr key={invoice.id}>
                      {deletable ? (
                        <Td className="w-9">
                          <SelectInvoice id={invoice.id} />
                        </Td>
                      ) : null}
                      <Td className="tabular font-medium whitespace-nowrap">
                        <Link
                          href={`/invoices/${invoice.id}`}
                          className="transition-colors hover:text-brand"
                        >
                          {invoice.number}
                        </Link>
                        {invoice.job ? (
                          <Link
                            href={`/jobs/${invoice.job.id}`}
                            className="block text-xs font-normal text-ink-subtle hover:text-brand"
                          >
                            {invoice.job.number}
                          </Link>
                        ) : null}
                      </Td>

                      <Td>
                        <Link
                          href={`/clients/${invoice.client.id}`}
                          className="block truncate text-ink transition-colors hover:text-brand"
                        >
                          {invoice.client.displayName}
                        </Link>
                      </Td>

                      <Td className="tabular hidden whitespace-nowrap text-ink-muted lg:table-cell">
                        {format(invoice.issueDate, "MMM d, yyyy")}
                      </Td>

                      <Td
                        className={cn(
                          "tabular hidden whitespace-nowrap sm:table-cell",
                          overdue ? "font-medium text-danger" : "text-ink-muted",
                        )}
                      >
                        {invoice.dueDate
                          ? format(invoice.dueDate, "MMM d, yyyy")
                          : "—"}
                      </Td>

                      <Td align="right" className="tabular whitespace-nowrap">
                        {money(invoice.totalCents)}
                      </Td>

                      <Td
                        align="right"
                        className="tabular font-medium whitespace-nowrap"
                      >
                        {invoice.balanceCents > 0 ? (
                          <span className={overdue ? "text-danger" : "text-warning"}>
                            {money(invoice.balanceCents)}
                          </span>
                        ) : (
                          <span className="text-success">Paid</span>
                        )}
                      </Td>

                      <Td>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>

            <Pagination
              page={list.page}
              pageCount={list.pageCount}
              total={list.total}
              pageSize={list.pageSize}
              pathname="/invoices"
              params={{
                q: params.q,
                status: params.status,
                clientId: params.clientId,
              }}
              itemLabel="invoices"
            />
          </InvoiceSelection>
        )}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "success" | "danger";
}) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-xs">
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p
        className={cn(
          "tabular mt-1.5 text-2xl font-semibold tracking-tight",
          tone === "success"
            ? "text-success"
            : tone === "danger"
              ? "text-danger"
              : "text-ink",
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-ink-subtle">{sub}</p> : null}
    </div>
  );
}

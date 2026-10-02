import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { Banknote, Paperclip, Plus, Repeat } from "lucide-react";

import {
  asExpensePeriod,
  expenseSummary,
  EXPENSE_PERIOD_LABELS,
  EXPENSE_PERIODS,
  listExpenses,
  listRepeatingExpenses,
  type RepeatingExpense,
} from "./queries";
import {
  ExpenseSelection,
  SelectAllExpenses,
  SelectExpense,
} from "./selection";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  type ExpenseCategory,
} from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";
import { describeRecurrence } from "@/lib/recurrence";
import { monthlyEquivalentCents } from "@/lib/recurring-expenses";
import { formatIn } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "Expenses" };

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    category?: string;
    period?: string;
    flag?: string;
    jobId?: string;
    clientId?: string;
    page?: string;
  }>;
}) {
  const { user, org } = await requirePermission("expenses:read");
  const params = await searchParams;
  const period = asExpensePeriod(params.period);

  const zone = await viewerTimeZone();
  const query = {
    organizationId: org.id,
    q: params.q,
    category: params.category,
    period,
    zone,
    flag: params.flag,
    jobId: params.jobId,
    clientId: params.clientId,
  };

  const [list, summary, repeating] = await Promise.all([
    listExpenses({ ...query, page: Number(params.page) || 1 }),
    expenseSummary(query),
    listRepeatingExpenses(org.id),
  ]);

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const writable = can(user, "expenses:write");
  const deletable = can(user, "expenses:delete");
  const isFiltered = Boolean(
    params.q || params.category || params.flag || params.jobId || params.clientId,
  );

  const top = summary.categories.slice(0, 4);
  const biggest = top[0]?.totalCents ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        description={`${money(list.totalCents)} across ${list.total} expense${
          list.total === 1 ? "" : "s"
        } · ${EXPENSE_PERIOD_LABELS[period].toLowerCase()}`}
        actions={
          writable ? (
            <Link href="/expenses/new" className={buttonClasses("primary", "md")}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              Record expense
            </Link>
          ) : null
        }
      />

      {summary.unreimbursedCount > 0 ? (
        <Link
          href="/expenses?flag=unreimbursed&period=all"
          className="flex flex-wrap items-center gap-3 rounded-card border border-warning/30 bg-warning/8 px-4 py-3 transition-colors hover:border-warning/50"
        >
          <Banknote className="h-4 w-4 shrink-0 text-warning" strokeWidth={1.75} />
          <p className="text-sm text-ink">
            <span className="font-medium">{money(summary.unreimbursedCents)}</span> owed
            back across {summary.unreimbursedCount} unsettled expense
            {summary.unreimbursedCount === 1 ? "" : "s"}.
          </p>
          <span className="ml-auto text-xs text-ink-muted">Review →</span>
        </Link>
      ) : null}

      {top.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {top.map((row) => (
            <Card key={row.category} className="p-4">
              <p className="truncate text-xs font-medium text-ink-muted">
                {EXPENSE_CATEGORY_LABELS[row.category]}
              </p>
              <p className="tabular mt-1 text-lg font-semibold text-ink">
                {money(row.totalCents)}
              </p>
              {/* Share of the largest category, so the bars compare to each other. */}
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-brand"
                  style={{
                    width: `${biggest > 0 ? Math.max((row.totalCents / biggest) * 100, 3) : 0}%`,
                  }}
                />
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      {repeating.length > 0 && !isFiltered ? (
        <RepeatingBills bills={repeating} money={money} zone={zone} />
      ) : null}

      <ListToolbar
        searchPlaceholder="Search description, vendor or reference…"
        filters={[
          {
            name: "period",
            label: "periods",
            allLabel: EXPENSE_PERIOD_LABELS["90d"],
            options: EXPENSE_PERIODS.filter((p) => p !== "90d").map((p) => ({
              value: p,
              label: EXPENSE_PERIOD_LABELS[p],
            })),
          },
          {
            name: "category",
            label: "categories",
            options: EXPENSE_CATEGORIES.map((category) => ({
              value: category,
              label: EXPENSE_CATEGORY_LABELS[category],
            })),
          },
          {
            name: "flag",
            label: "expenses",
            options: [
              { value: "billable", label: "Rebillable" },
              { value: "reimbursable", label: "Reimbursable" },
              { value: "unreimbursed", label: "Owed back" },
            ],
          },
        ]}
      />

      <Card className="overflow-hidden">
        {list.rows.length === 0 ? (
          <EmptyState
            icon={<Banknote className="h-5 w-5" strokeWidth={1.75} />}
            title={isFiltered ? "No matches" : "Nothing recorded yet"}
            description={
              isFiltered
                ? "Try a different search or clear the filters."
                : "Record what the business spends and it lands here, ready to set against revenue."
            }
            action={
              writable && !isFiltered ? (
                <Link
                  href="/expenses/new"
                  className={buttonClasses("outline", "md")}
                >
                  Record the first expense
                </Link>
              ) : null
            }
          />
        ) : (
          <ExpenseSelection canDelete={deletable}>
            <Table>
              <THead>
                {deletable ? (
                  <Th className="w-9">
                    <SelectAllExpenses ids={list.rows.map((row) => row.id)} />
                  </Th>
                ) : null}
                <Th>Date</Th>
                <Th>Description</Th>
                <Th className="hidden sm:table-cell">Category</Th>
                <Th className="hidden lg:table-cell">Vendor</Th>
                <Th className="hidden xl:table-cell">Booked to</Th>
                <Th align="right">Amount</Th>
              </THead>

              <TBody>
                {list.rows.map((expense) => {
                  const category = asStatus(
                    EXPENSE_CATEGORIES,
                    expense.category,
                    "OTHER",
                  ) as ExpenseCategory;

                  return (
                    <Tr key={expense.id}>
                      {deletable ? (
                        <Td className="w-9">
                          <SelectExpense id={expense.id} />
                        </Td>
                      ) : null}
                      <Td className="tabular whitespace-nowrap text-ink-muted">
                        {format(expense.spentAt, "MMM d, yyyy")}
                      </Td>

                      <Td>
                        <Link
                          href={`/expenses/${expense.id}`}
                          className="flex min-w-0 items-center gap-2 font-medium text-ink transition-colors hover:text-brand"
                        >
                          <span className="truncate">{expense.description}</span>
                          {expense.scheduleId ? (
                            <Repeat
                              className="h-3.5 w-3.5 shrink-0 text-ink-subtle"
                              strokeWidth={1.75}
                              aria-label="A repeating bill"
                            />
                          ) : null}
                          {expense._count.attachments > 0 ? (
                            <Paperclip
                              className="h-3.5 w-3.5 shrink-0 text-ink-subtle"
                              strokeWidth={1.75}
                              aria-label="Has a receipt"
                            />
                          ) : null}
                        </Link>

                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {expense.billable ? (
                            <Badge tone="accent">Rebillable</Badge>
                          ) : null}
                          {expense.reimbursable && !expense.reimbursedAt ? (
                            <Badge tone="warning">
                              Owed to {expense.paidBy?.name ?? "payer"}
                            </Badge>
                          ) : null}
                        </div>
                      </Td>

                      <Td className="hidden text-ink-muted sm:table-cell">
                        {EXPENSE_CATEGORY_LABELS[category]}
                      </Td>

                      <Td className="hidden text-ink-subtle lg:table-cell">
                        {expense.vendor ?? "—"}
                      </Td>

                      <Td className="hidden xl:table-cell">
                        {expense.job ? (
                          <Link
                            href={`/jobs/${expense.job.id}`}
                            className="tabular text-ink-muted transition-colors hover:text-brand"
                          >
                            {expense.job.number}
                          </Link>
                        ) : expense.client ? (
                          <Link
                            href={`/clients/${expense.client.id}`}
                            className="text-ink-muted transition-colors hover:text-brand"
                          >
                            {expense.client.displayName}
                          </Link>
                        ) : (
                          <span className="text-ink-subtle">Overhead</span>
                        )}
                      </Td>

                      <Td
                        align="right"
                        className="tabular font-medium whitespace-nowrap text-ink"
                      >
                        {money(expense.amountCents)}
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
              pathname="/expenses"
              params={{
                q: params.q,
                category: params.category,
                period: params.period,
                flag: params.flag,
                jobId: params.jobId,
                clientId: params.clientId,
              }}
              itemLabel="expenses"
            />
          </ExpenseSelection>
        )}
      </Card>
    </div>
  );
}

/**
 * The bills that come round again, folded away under one line: how many, what
 * the fixed ones come to a month, and what is next. Opened, each links to its
 * latest expense, where the repeat is changed or stopped.
 */
function RepeatingBills({
  bills,
  money,
  zone,
}: {
  bills: RepeatingExpense[];
  money: (cents: number) => string;
  zone: string;
}) {
  // Only the fixed ones have a known amount. A bill that changes every time
  // is left out of the total rather than guessed at.
  const fixedMonthly = bills
    .filter((bill) => !bill.amountVaries)
    .reduce(
      (total, bill) =>
        total + monthlyEquivalentCents(bill.latest.amountCents, bill.frequency, bill.interval),
      0,
    );
  const next = bills[0];

  return (
    <details className="group rounded-card border border-line bg-surface">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
        <Repeat className="h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} />
        <span className="font-medium text-ink">
          {bills.length} repeating bill{bills.length === 1 ? "" : "s"}
        </span>
        {fixedMonthly > 0 ? (
          <span className="text-ink-muted">
            about <span className="tabular">{money(fixedMonthly)}</span> a month fixed
          </span>
        ) : null}
        <span className="text-ink-subtle">
          next: {next.latest.description} on {formatIn(next.nextDate, "MMM d", zone)}
        </span>
        <span className="ml-auto text-xs text-ink-muted group-open:hidden">Show</span>
        <span className="ml-auto hidden text-xs text-ink-muted group-open:inline">Hide</span>
      </summary>

      <ul className="divide-y divide-line border-t border-line">
        {bills.map((bill) => (
          <li key={bill.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
            <Link
              href={`/expenses/${bill.latest.id}`}
              className="min-w-0 truncate font-medium text-ink transition-colors hover:text-brand"
            >
              {bill.latest.description}
            </Link>
            <span className="text-xs text-ink-subtle">
              {describeRecurrence(bill)} · next {formatIn(bill.nextDate, "MMM d", zone)}
            </span>
            <span className="tabular ml-auto text-ink-muted">
              {bill.amountVaries ? "You enter it" : money(bill.latest.amountCents)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

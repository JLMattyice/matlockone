import Link from "next/link";
import { endOfDay, format, startOfDay } from "date-fns";
import { Repeat } from "lucide-react";

import { ExpenseRepeatForm } from "./repeat-form";
import { stopExpenseRepeat } from "../repeat";
import type { ExpenseSeries } from "../queries";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  asStatus,
  INVOICE_REPEAT_FREQUENCIES,
  RECURRENCE_FREQUENCIES,
  type InvoiceRepeatFrequency,
} from "@/lib/constants";
import { describeRecurrence, nextNotBefore } from "@/lib/recurrence";
import { formatIn, instant, nowIn } from "@/lib/time-zone";
import { cn } from "@/lib/utils";

/** "Every month · recorded automatically · next Oct 15, 2026", or what stopped it. */
export function expenseRepeatSummary(series: ExpenseSeries): string {
  const rhythm = describeRecurrence(series);

  if (series.isActive) {
    const how = series.amountVaries ? "you enter the amount" : "recorded automatically";
    return `${rhythm} · ${how} · next ${format(series.nextDate, "MMM d, yyyy")}`;
  }

  if (series.endDate && series.nextDate > endOfDay(series.endDate)) {
    return `Finished — the last was due ${format(series.endDate, "MMM d, yyyy")}`;
  }

  return `Stopped · was ${rhythm.toLowerCase()}`;
}

/**
 * The Repeat card on an expense.
 *
 * Shows the series this expense belongs to, if any, and lets somebody who can
 * record expenses start, change or stop the repeat. The latest in the series
 * are listed so any of them leads to the rest.
 */
export function ExpenseRepeatCard({
  expense,
  series,
  canEdit,
  money,
  zone,
}: {
  expense: { id: string; spentAt: Date; category: string };
  series: ExpenseSeries | null;
  canEdit: boolean;
  money: (cents: number) => string;
  /** The viewer's time zone: "today" in the form is their today. */
  zone: string;
}) {
  const day = (date: Date) => formatIn(date, "yyyy-MM-dd", zone);
  const today = instant(startOfDay(nowIn(zone)));

  const frequency = asStatus(
    INVOICE_REPEAT_FREQUENCIES,
    series?.frequency ?? "MONTHLY",
    "MONTHLY",
  ) as InvoiceRepeatFrequency;

  // The default next date follows the latest in the series — the one the next
  // copies — or this expense when there is no series yet.
  const latest = series?.expenses[0]?.spentAt ?? expense.spentAt;

  // A stopped repeat starts again where its rhythm is now, not on the date it
  // stopped at, which has usually gone by. One that is due and not yet done
  // opens on today.
  const nextDate = !series
    ? null
    : series.nextDate >= today
      ? series.nextDate
      : series.isActive
        ? today
        : nextNotBefore(
            series.nextDate,
            asStatus(RECURRENCE_FREQUENCIES, series.frequency, "MONTHLY"),
            series.interval,
            today,
            series.anchorDate,
          );

  const earlier = series ? series._count.expenses - series.expenses.length : 0;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <Repeat className="h-3.5 w-3.5 text-ink-subtle" strokeWidth={2} />
            Repeat
          </span>
        }
        description={
          series
            ? expenseRepeatSummary(series)
            : "For bills that come round again — rent, software, insurance, utilities."
        }
      />

      {series ? (
        <div className="border-b border-line">
          <p className="px-5 pt-3 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
            In this series
          </p>
          <ul className="divide-y divide-line">
            {series.expenses.map((item) => {
              const current = item.id === expense.id;
              return (
                <li
                  key={item.id}
                  className={cn(
                    "flex items-center justify-between gap-3 px-5 py-2 text-sm",
                    current && "bg-surface-2",
                  )}
                >
                  {current ? (
                    <span className="font-medium text-ink">
                      {formatIn(item.spentAt, "MMM d, yyyy", zone)}
                      <span className="ml-1.5 text-xs font-normal text-ink-subtle">this one</span>
                    </span>
                  ) : (
                    <Link
                      href={`/expenses/${item.id}`}
                      className="font-medium text-ink transition-colors hover:text-brand"
                    >
                      {formatIn(item.spentAt, "MMM d, yyyy", zone)}
                    </Link>
                  )}
                  <span className="tabular text-ink-muted">{money(item.amountCents)}</span>
                </li>
              );
            })}
          </ul>
          {earlier > 0 ? (
            <p className="px-5 pb-3 text-xs text-ink-subtle">and {earlier} earlier</p>
          ) : null}
        </div>
      ) : null}

      {series?.isActive && series.endDate ? (
        <p className="border-b border-line px-5 py-3 text-xs text-ink-muted">
          Nothing after {format(series.endDate, "MMM d, yyyy")}.
        </p>
      ) : null}

      {canEdit ? (
        <div className="px-5 py-4">
          <ExpenseRepeatForm
            expenseId={expense.id}
            baseDate={day(latest)}
            today={day(today)}
            initial={{
              frequency,
              interval: series?.interval ?? 1,
              nextDate: series ? day(nextDate ?? today) : null,
              endDate: series?.endDate ? day(series.endDate) : null,
              // Utilities are the bill whose amount moves; everything else
              // starts as the same each time.
              amountVaries: series ? series.amountVaries : expense.category === "UTILITIES",
            }}
            openLabel={
              !series ? "Repeat this expense" : series.isActive ? "Change" : "Start again"
            }
            aside={
              series?.isActive ? (
                <form action={stopExpenseRepeat}>
                  <input type="hidden" name="expenseId" value={expense.id} />
                  <ConfirmButton variant="ghost" size="sm" confirmLabel="Stop it?">
                    Stop repeating
                  </ConfirmButton>
                </form>
              ) : null
            }
          />
        </div>
      ) : null}
    </Card>
  );
}

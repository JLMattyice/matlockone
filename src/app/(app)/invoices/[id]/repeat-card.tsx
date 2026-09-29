import Link from "next/link";
import { endOfDay, format, startOfDay } from "date-fns";
import { Repeat } from "lucide-react";

import { RepeatForm } from "./repeat-form";
import { stopInvoiceRepeat } from "../repeat";
import type { InvoiceSeries } from "../queries";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  INVOICE_REPEAT_FREQUENCIES,
  INVOICE_STATUS_META,
  RECURRENCE_FREQUENCIES,
  asStatus,
  type InvoiceRepeatFrequency,
} from "@/lib/constants";
import { effectiveInvoiceStatus } from "@/lib/documents";
import { describeRecurrence, nextNotBefore } from "@/lib/recurrence";
import { cn } from "@/lib/utils";

const day = (date: Date) => format(date, "yyyy-MM-dd");

/** "Every month · next draft Oct 28, 2026", or what stopped it. */
export function repeatSummary(series: InvoiceSeries): string {
  const rhythm = describeRecurrence(series);

  if (series.isActive) {
    return `${rhythm} · next draft ${format(series.nextIssueDate, "MMM d, yyyy")}`;
  }

  if (series.endDate && series.nextIssueDate > endOfDay(series.endDate)) {
    return `Finished — the last was due ${format(series.endDate, "MMM d, yyyy")}`;
  }

  return `Stopped · was ${rhythm.toLowerCase()}`;
}

/**
 * The Repeat card on an invoice.
 *
 * Shows the series this invoice belongs to, if any, and lets somebody who can
 * write invoices start, change or stop the repeat. The latest invoices in the
 * series are listed so the drafts it has made can be found from any of them.
 */
export function RepeatCard({
  invoice,
  series,
  canEdit,
}: {
  invoice: { id: string; issueDate: Date };
  series: InvoiceSeries | null;
  canEdit: boolean;
}) {
  const today = startOfDay(new Date());

  const frequency = asStatus(
    INVOICE_REPEAT_FREQUENCIES,
    series?.frequency ?? "MONTHLY",
    "MONTHLY",
  ) as InvoiceRepeatFrequency;

  // The default next date follows the latest invoice in the series — the one
  // the next draft copies — or this invoice when there is no series yet.
  const latest = series?.invoices[0]?.issueDate ?? invoice.issueDate;

  // The date the form opens on. A stopped repeat starts again where its rhythm
  // is now, not on the date it stopped at, which has usually gone by — saving
  // that would make a draft for every period since. An active one that is due
  // and not yet made opens on today.
  const nextDate = !series
    ? null
    : series.nextIssueDate >= today
      ? series.nextIssueDate
      : series.isActive
        ? today
        : nextNotBefore(
            series.nextIssueDate,
            asStatus(RECURRENCE_FREQUENCIES, series.frequency, "MONTHLY"),
            series.interval,
            today,
            series.anchorDate,
          );

  const earlier = series ? series._count.invoices - series.invoices.length : 0;

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
            ? repeatSummary(series)
            : "Make the next one as a draft on a schedule, for you to check and send."
        }
      />

      {series ? (
        <div className="border-b border-line">
          <p className="px-5 pt-3 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
            In this series
          </p>
          <ul className="divide-y divide-line">
            {series.invoices.map((item) => {
              const meta = INVOICE_STATUS_META[effectiveInvoiceStatus(item)];
              const current = item.id === invoice.id;

              return (
                <li
                  key={item.id}
                  className={cn(
                    "flex items-center justify-between gap-3 px-5 py-2 text-sm",
                    current && "bg-surface-2",
                  )}
                >
                  <span className="min-w-0">
                    {current ? (
                      <span className="tabular block font-medium text-ink">
                        {item.number}
                        <span className="ml-1.5 text-xs font-normal text-ink-subtle">this one</span>
                      </span>
                    ) : (
                      <Link
                        href={`/invoices/${item.id}`}
                        className="tabular block font-medium text-ink transition-colors hover:text-brand"
                      >
                        {item.number}
                      </Link>
                    )}
                    <span className="block text-xs text-ink-muted">
                      {format(item.issueDate, "MMM d, yyyy")}
                    </span>
                  </span>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </li>
              );
            })}
          </ul>
          {earlier > 0 ? (
            <p className="px-5 pb-3 text-xs text-ink-subtle">
              and {earlier} earlier
            </p>
          ) : null}
        </div>
      ) : null}

      {series?.isActive && series.endDate ? (
        <p className="border-b border-line px-5 py-3 text-xs text-ink-muted">
          No drafts after {format(series.endDate, "MMM d, yyyy")}.
        </p>
      ) : null}

      {canEdit ? (
        <div className="px-5 py-4">
          <RepeatForm
            invoiceId={invoice.id}
            baseDate={day(latest)}
            today={day(today)}
            initial={
              series
                ? {
                    frequency,
                    interval: series.interval,
                    nextIssueDate: day(nextDate ?? today),
                    endDate: series.endDate ? day(series.endDate) : null,
                  }
                : null
            }
            openLabel={
              !series ? "Repeat this invoice" : series.isActive ? "Change" : "Start again"
            }
            aside={
              series?.isActive ? (
                <form action={stopInvoiceRepeat}>
                  <input type="hidden" name="invoiceId" value={invoice.id} />
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

import { format } from "date-fns";

import { formatMoney, formatMoneyCompact } from "@/lib/money";
import { cn } from "@/lib/utils";

export type CashFlowBucket = {
  date: Date;
  inCents: number;
  outCents: number;
};

/**
 * Six months of money in, and — for roles that may see it — money out beside
 * it. Both bars share one vertical scale, because the only reason to put them
 * next to each other is to compare their heights.
 *
 * Rendered as bars with the figures repeated for a screen reader, so nothing
 * here depends on seeing the shapes.
 */
export function CashFlowChart({
  buckets,
  currency,
  locale,
  showSpend = false,
}: {
  buckets: CashFlowBucket[];
  currency: string;
  locale: string;
  showSpend?: boolean;
}) {
  const peak = Math.max(
    ...buckets.map((b) => Math.max(b.inCents, showSpend ? b.outCents : 0)),
    1,
  );

  const money = (cents: number) => formatMoney(cents, currency, locale);
  const height = (cents: number) => `${Math.max((cents / peak) * 100, 2)}%`;

  const totalIn = buckets.reduce((sum, b) => sum + b.inCents, 0);
  const totalOut = buckets.reduce((sum, b) => sum + b.outCents, 0);

  return (
    <div>
      {showSpend ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
          <Key className="bg-brand" label="Collected" value={money(totalIn)} />
          <Key className="bg-warning/70" label="Spent" value={money(totalOut)} />
        </div>
      ) : null}

      {/*
        No `items-end` on this row: it would size each column to its own
        content, leaving the flex-1 bar track inside with no height for the
        bars to fill against. The track does the bottom-alignment instead.
      */}
      <div className="flex h-44 gap-2 sm:gap-3">
        {buckets.map((bucket, index) => {
          const isCurrent = index === buckets.length - 1;

          return (
            <div
              key={bucket.date.toISOString()}
              className="flex min-w-0 flex-1 flex-col items-center gap-2"
            >
              <span className="tabular text-[0.6875rem] font-medium text-ink-muted">
                {bucket.inCents > 0
                  ? formatMoneyCompact(bucket.inCents, currency, locale)
                  : "—"}
              </span>

              <div className="flex w-full flex-1 items-end justify-center gap-0.5">
                <div
                  className={cn(
                    "rounded-t-md",
                    showSpend ? "w-1/2" : "w-full",
                    // The month in progress is the one being asked about, so
                    // it reads solid while the settled months sit back.
                    isCurrent ? "bg-brand" : "bg-brand/35",
                  )}
                  style={{ height: height(bucket.inCents) }}
                  aria-hidden
                />
                {showSpend ? (
                  <div
                    className={cn(
                      "w-1/2 rounded-t-md",
                      isCurrent ? "bg-warning/70" : "bg-warning/30",
                    )}
                    style={{ height: height(bucket.outCents) }}
                    aria-hidden
                  />
                ) : null}
              </div>

              <span className="text-[0.6875rem] text-ink-subtle">
                {format(bucket.date, "MMM")}
              </span>

              <span className="sr-only">
                {format(bucket.date, "MMMM yyyy")}: {money(bucket.inCents)}{" "}
                collected
                {showSpend ? `, ${money(bucket.outCents)} spent` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Key({
  className,
  label,
  value,
}: {
  className: string;
  label: string;
  value: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2.5 w-2.5 rounded-sm", className)} aria-hidden />
      <span className="text-ink-muted">{label}</span>
      <span className="tabular font-medium text-ink">{value}</span>
    </span>
  );
}

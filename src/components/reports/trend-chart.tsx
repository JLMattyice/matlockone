import { format } from "date-fns";

import { formatMoney, formatMoneyCompact } from "@/lib/money";
import { cn } from "@/lib/utils";

export type TrendBucket = {
  date: Date;
  label: string;
  inCents: number;
  outCents: number;
};

/**
 * Money in and money out over time.
 *
 * The two bars share one vertical scale so their heights are comparable — the
 * whole point of putting them side by side is seeing which is taller. Rendered
 * with a screen-reader table underneath, so the figures are available without
 * the visual. Value labels are dropped once the buckets get dense (a 31-day
 * month) because they would overlap into noise; the tooltip and the accessible
 * text still carry the exact number.
 */
export function TrendChart({
  buckets,
  currency,
  locale,
  showSpend = false,
}: {
  buckets: TrendBucket[];
  currency: string;
  locale: string;
  /** Hidden from anyone whose role cannot see expenses. */
  showSpend?: boolean;
}) {
  if (buckets.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-ink-subtle">
        No data for this period.
      </p>
    );
  }

  const peak = Math.max(
    ...buckets.map((b) => Math.max(b.inCents, showSpend ? b.outCents : 0)),
    1,
  );
  const dense = buckets.length > 14;

  const totalIn = buckets.reduce((sum, b) => sum + b.inCents, 0);
  const totalOut = buckets.reduce((sum, b) => sum + b.outCents, 0);

  const money = (cents: number) => formatMoney(cents, currency, locale);
  const height = (cents: number) =>
    cents > 0 ? `${Math.max((cents / peak) * 100, 1.5)}%` : "0%";

  return (
    <figure>
      {showSpend ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
          <Key className="bg-brand/70" label="Collected" value={money(totalIn)} />
          <Key className="bg-warning/70" label="Spent" value={money(totalOut)} />
        </div>
      ) : null}

      {/*
        No `items-end` here: it would size each column to its own content, so
        the flex-1 bar track inside would have no height to fill and every bar
        would resolve its percentage against zero. The columns stretch; the
        track inside each one does the bottom-alignment.
      */}
      <div className="flex h-52 gap-1 sm:gap-1.5">
        {buckets.map((bucket) => (
          <div
            key={bucket.date.toISOString()}
            className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
            title={
              showSpend
                ? `${format(bucket.date, "MMM d, yyyy")} — in ${money(
                    bucket.inCents,
                  )}, out ${money(bucket.outCents)}`
                : `${format(bucket.date, "MMM d, yyyy")}: ${money(bucket.inCents)}`
            }
          >
            {!dense ? (
              <span className="tabular text-[0.625rem] font-medium text-ink-muted">
                {bucket.inCents > 0
                  ? formatMoneyCompact(bucket.inCents, currency, locale)
                  : ""}
              </span>
            ) : null}

            <div className="flex w-full flex-1 items-end justify-center gap-px">
              {bucket.inCents > 0 || bucket.outCents > 0 ? (
                <>
                  <div
                    className={cn(
                      "rounded-t-sm bg-brand/70 transition-colors hover:bg-brand",
                      showSpend ? "w-1/2" : "w-full",
                    )}
                    style={{ height: height(bucket.inCents) }}
                    aria-hidden
                  />
                  {showSpend ? (
                    <div
                      className="w-1/2 rounded-t-sm bg-warning/70 transition-colors hover:bg-warning"
                      style={{ height: height(bucket.outCents) }}
                      aria-hidden
                    />
                  ) : null}
                </>
              ) : (
                <div className="h-px w-full bg-line" aria-hidden />
              )}
            </div>

            <span
              className={cn(
                "truncate text-[0.625rem] text-ink-subtle",
                dense && "hidden sm:block",
              )}
            >
              {bucket.label}
            </span>
          </div>
        ))}
      </div>

      <figcaption className="sr-only">
        <table>
          <caption>
            {showSpend
              ? `Money in and out by period. Collected ${money(
                  totalIn,
                )}, spent ${money(totalOut)}.`
              : `Revenue by period, total ${money(totalIn)}`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Collected</th>
              {showSpend ? <th scope="col">Spent</th> : null}
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.date.toISOString()}>
                <th scope="row">{format(bucket.date, "MMMM d, yyyy")}</th>
                <td>{money(bucket.inCents)}</td>
                {showSpend ? <td>{money(bucket.outCents)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
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

/** Horizontal proportion bar used by the breakdown tables. */
export function ShareBar({
  value,
  peak,
  tone = "brand",
}: {
  value: number;
  peak: number;
  tone?: "brand" | "warning";
}) {
  const pct = peak > 0 ? Math.max((value / peak) * 100, 1) : 0;

  return (
    <span
      className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
      aria-hidden
    >
      <span
        className={cn(
          "block h-full rounded-full",
          tone === "warning" ? "bg-warning/60" : "bg-brand/60",
        )}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

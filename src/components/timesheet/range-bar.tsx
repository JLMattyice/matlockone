import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { DateSpanForm } from "./date-span-form";
import { buttonClasses } from "@/components/ui/button";
import {
  rangeLabel,
  rangeQuery,
  type TimesheetPreset,
  type TimesheetRange,
  type TimesheetSpan,
} from "@/lib/timesheet";

/**
 * Which days a timesheet page is showing, and the ways to change them: a step
 * back or forward by the span's own length, the spans people ask for by name,
 * and any two dates. Shared, so the team's page, one person's and the crew's
 * own all move the same way.
 */
export function RangeBar({
  path,
  range,
  presets,
}: {
  /** The page these links come back to, without a query string. */
  path: string;
  range: TimesheetRange;
  presets: TimesheetPreset[];
}) {
  const href = (span: TimesheetSpan) => `${path}?${rangeQuery(span)}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Link href={href(range.previous)} className={buttonClasses("outline", "icon")} aria-label="Earlier">
          <ChevronLeft className="h-4 w-4" strokeWidth={2} />
        </Link>
        <p className="tabular min-w-0 flex-1 text-center text-sm font-medium text-ink sm:flex-none sm:px-3">
          {rangeLabel(range)}
        </p>
        <Link href={href(range.next)} className={buttonClasses("outline", "icon")} aria-label="Later">
          <ChevronRight className="h-4 w-4" strokeWidth={2} />
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex flex-wrap gap-1 rounded-lg border border-line p-0.5">
          {presets.map((preset) => {
            const active = preset.from === range.from && preset.to === range.to;
            return (
              <Link
                key={preset.label}
                href={href(preset)}
                aria-current={active ? "true" : undefined}
                className={
                  active
                    ? "rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink"
                    : "rounded-md px-3 py-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
                }
              >
                {preset.label}
              </Link>
            );
          })}
        </div>

        {/* Keyed by the span, so stepping to another week refills the boxes. */}
        <DateSpanForm key={`${range.from}:${range.to}`} path={path} from={range.from} to={range.to} />
      </div>
    </div>
  );
}

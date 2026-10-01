import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function StatTile({
  label,
  value,
  sublabel,
  icon: Icon,
  tone = "neutral",
  href,
  className: extra,
}: {
  label: string;
  value: string;
  sublabel?: string;
  icon: LucideIcon;
  tone?: "neutral" | "brand" | "success" | "warning" | "danger";
  href?: string;
  /** Placement in the parent grid, such as a column span. */
  className?: string;
}) {
  const iconTone = {
    neutral: "bg-surface-3 text-ink-muted",
    brand: "bg-brand/10 text-brand",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-danger/10 text-danger",
  }[tone];

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-ink-muted sm:text-sm">{label}</p>
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            iconTone,
          )}
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </span>
      </div>
      {/* Smaller on a phone, where two tiles share the width; and allowed to
          break rather than push the page sideways on a seven-figure month. */}
      <p className="tabular mt-3 text-xl font-semibold tracking-tight [overflow-wrap:anywhere] text-ink sm:text-2xl">
        {value}
      </p>
      {sublabel ? (
        <p className="mt-1 text-xs text-ink-subtle">{sublabel}</p>
      ) : null}
    </>
  );

  const className = cn(
    "min-w-0 rounded-card border border-line bg-surface p-3.5 shadow-xs sm:p-4",
    href && "transition-colors hover:border-line-strong hover:bg-surface-2",
    extra,
  );

  return href ? (
    <Link href={href} className={cn(className, "block")}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}

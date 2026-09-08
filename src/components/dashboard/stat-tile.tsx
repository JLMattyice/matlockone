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
}: {
  label: string;
  value: string;
  sublabel?: string;
  icon: LucideIcon;
  tone?: "neutral" | "brand" | "success" | "warning" | "danger";
  href?: string;
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
        <p className="text-sm font-medium text-ink-muted">{label}</p>
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            iconTone,
          )}
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </span>
      </div>
      <p className="tabular mt-3 text-2xl font-semibold tracking-tight text-ink">
        {value}
      </p>
      {sublabel ? (
        <p className="mt-1 text-xs text-ink-subtle">{sublabel}</p>
      ) : null}
    </>
  );

  const className = cn(
    "rounded-card border border-line bg-surface p-4 shadow-xs",
    href && "transition-colors hover:border-line-strong hover:bg-surface-2",
  );

  return href ? (
    <Link href={href} className={cn(className, "block")}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}

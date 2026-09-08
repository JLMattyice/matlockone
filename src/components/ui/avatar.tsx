import { Building2 } from "lucide-react";

import { cn, initials } from "@/lib/utils";

const SIZES = {
  sm: "h-7 w-7 text-[0.625rem]",
  md: "h-9 w-9 text-xs",
  lg: "h-12 w-12 text-sm",
} as const;

export function Avatar({
  name,
  imageUrl,
  isBusiness,
  size = "md",
  className,
}: {
  name: string;
  imageUrl?: string | null;
  isBusiness?: boolean;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const base = cn(
    "flex shrink-0 items-center justify-center rounded-full font-semibold",
    SIZES[size],
    className,
  );

  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={imageUrl} alt="" className={cn(base, "object-cover")} />
    );
  }

  if (isBusiness) {
    return (
      <span className={cn(base, "bg-surface-3 text-ink-muted")} aria-hidden>
        <Building2 className="h-1/2 w-1/2" strokeWidth={1.75} />
      </span>
    );
  }

  return (
    <span className={cn(base, "bg-brand/12 text-brand")} aria-hidden>
      {initials(name)}
    </span>
  );
}

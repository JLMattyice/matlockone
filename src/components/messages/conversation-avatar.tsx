import { Briefcase, Users } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type Face = { name: string; avatarUrl: string | null; isActive: boolean };

/**
 * The other person's face, or a mark for a group or a job.
 *
 * Groups and jobs get an icon rather than a stack of faces: at inbox size two
 * sets of overlapping initials read as a smudge, and the name beside it
 * already says what it is.
 */
export function ConversationAvatar({
  kind,
  others,
  className,
}: {
  kind: string;
  others: Face[];
  className?: string;
}) {
  const person = others[0];

  if (kind === "DIRECT" && person) {
    return (
      <Avatar
        name={person.name}
        imageUrl={person.avatarUrl}
        className={cn(!person.isActive && "opacity-50 grayscale", className)}
      />
    );
  }

  const Icon = kind === "JOB" ? Briefcase : Users;

  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
        // Neutral for jobs rather than the org's accent colour, which is
        // chosen for a logo and may not be legible on a tint of itself.
        kind === "JOB" ? "bg-surface-3 text-ink-muted" : "bg-brand/12 text-brand",
        className,
      )}
      aria-hidden
    >
      <Icon className="h-4 w-4" strokeWidth={1.75} />
    </span>
  );
}

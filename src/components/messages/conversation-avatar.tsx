import { Users } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type Face = { name: string; avatarUrl: string | null; isActive: boolean };

/**
 * The other person's face, or a group mark.
 *
 * Groups get an icon rather than a stack of faces: at inbox size two sets of
 * overlapping initials read as a smudge, and the name beside it already says
 * who is in it.
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

  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/12 text-brand",
        className,
      )}
      aria-hidden
    >
      <Users className="h-4 w-4" strokeWidth={1.75} />
    </span>
  );
}

import {
  Bookmark,
  Briefcase,
  CalendarCheck,
  Flag,
  Megaphone,
  Rocket,
  Ticket,
  Users,
  type LucideIcon,
} from "lucide-react";

import { asStatus, JOB_KINDS, type JobKind } from "@/lib/constants";
import { cn } from "@/lib/utils";

const ICONS: Record<JobKind, LucideIcon> = {
  JOB: Briefcase,
  APPOINTMENT: CalendarCheck,
  MEETING: Users,
  DEADLINE: Flag,
  LAUNCH: Rocket,
  SOCIAL_POST: Megaphone,
  EVENT: Ticket,
  OTHER: Bookmark,
};

/** The mark that tells a launch from a job at a glance on the calendar. */
export function KindIcon({
  kind,
  className,
}: {
  kind: string;
  className?: string;
}) {
  const Icon = ICONS[asStatus(JOB_KINDS, kind, "JOB")];
  return (
    <Icon
      className={cn("h-3 w-3 shrink-0", className)}
      strokeWidth={2}
      aria-hidden
    />
  );
}

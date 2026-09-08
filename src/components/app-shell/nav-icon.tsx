import {
  Banknote,
  BarChart3,
  Briefcase,
  Calendar,
  CreditCard,
  FileText,
  FolderClosed,
  HardHat,
  LayoutDashboard,
  Receipt,
  Settings,
  Target,
  Users,
} from "lucide-react";

import type { NavIcon as NavIconName } from "@/lib/navigation";

const ICONS = {
  dashboard: LayoutDashboard,
  calendar: Calendar,
  briefcase: Briefcase,
  "file-text": FileText,
  receipt: Receipt,
  "credit-card": CreditCard,
  banknote: Banknote,
  users: Users,
  target: Target,
  "hard-hat": HardHat,
  "bar-chart": BarChart3,
  folder: FolderClosed,
  settings: Settings,
} as const;

export function NavIcon({
  name,
  className,
}: {
  name: NavIconName;
  className?: string;
}) {
  const Icon = ICONS[name];
  return <Icon className={className} strokeWidth={1.75} aria-hidden />;
}

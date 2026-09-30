import {
  Bookmark,
  Briefcase,
  Building2,
  CalendarCheck,
  Camera,
  Coffee,
  DollarSign,
  Dumbbell,
  Flag,
  Gift,
  GraduationCap,
  Heart,
  House,
  Leaf,
  Mail,
  Megaphone,
  Mic,
  Music,
  Newspaper,
  Package,
  Palette,
  PenLine,
  Phone,
  Plane,
  Rocket,
  Scissors,
  ShoppingBag,
  Sparkles,
  Star,
  Tag,
  Ticket,
  Truck,
  Users,
  Utensils,
  Video,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type { CategoryIcon } from "@/lib/constants";
import { asCategoryIcon } from "@/lib/job-categories";
import { cn } from "@/lib/utils";

const ICONS: Record<CategoryIcon, LucideIcon> = {
  tag: Tag,
  star: Star,
  heart: Heart,
  sparkles: Sparkles,
  camera: Camera,
  video: Video,
  mic: Mic,
  music: Music,
  mail: Mail,
  phone: Phone,
  newspaper: Newspaper,
  "pen-line": PenLine,
  megaphone: Megaphone,
  rocket: Rocket,
  ticket: Ticket,
  gift: Gift,
  "shopping-bag": ShoppingBag,
  package: Package,
  truck: Truck,
  wrench: Wrench,
  scissors: Scissors,
  palette: Palette,
  utensils: Utensils,
  coffee: Coffee,
  dumbbell: Dumbbell,
  "graduation-cap": GraduationCap,
  plane: Plane,
  leaf: Leaf,
  house: House,
  building: Building2,
  "dollar-sign": DollarSign,
  users: Users,
  flag: Flag,
  "calendar-check": CalendarCheck,
  briefcase: Briefcase,
  bookmark: Bookmark,
};

/** The mark that tells a launch, or a business's own category, from a job. */
export function CategoryMark({
  icon,
  className,
}: {
  icon: string;
  className?: string;
}) {
  const Icon = ICONS[asCategoryIcon(icon)];
  return (
    <Icon
      className={cn("h-3 w-3 shrink-0", className)}
      strokeWidth={2}
      aria-hidden
    />
  );
}

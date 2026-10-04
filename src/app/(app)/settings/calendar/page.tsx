import type { Metadata } from "next";

import { CalendarSettingsForm } from "./calendar-form";
import { calendarSettings } from "./queries";
import { requirePermission } from "@/lib/auth";
import { parseBillRoles } from "@/lib/bills-calendar";
import { parseHiddenKinds } from "@/lib/job-categories";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Calendar" };

export default async function CalendarSettingsPage() {
  const { user, org } = await requirePermission("settings:read");
  const { categories, builtInCounts } = await calendarSettings(org.id);

  return (
    <CalendarSettingsForm
      categories={categories}
      builtInCounts={builtInCounts}
      hiddenKinds={parseHiddenKinds(org.hiddenJobKinds)}
      billRoles={parseBillRoles(org.billsOnCalendarRoles)}
      jobLabel={org.labelJobSingular}
      jobPlural={org.labelJobPlural}
      readOnly={!can(user, "settings:write")}
    />
  );
}

import type { Metadata } from "next";

import { ChecklistSettingsForm, type AppliesToOption } from "./checklists-form";
import { jobCategories } from "../calendar/queries";
import { requirePermission } from "@/lib/auth";
import { readChecklistItems } from "@/lib/checklists";
import { prisma } from "@/lib/db";
import { categoryOptions, categoryValue, parseHiddenKinds } from "@/lib/job-categories";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Checklists" };

export default async function ChecklistSettingsPage() {
  const { user, org } = await requirePermission("settings:read");

  const [templates, categories] = await Promise.all([
    prisma.checklistTemplate.findMany({
      where: { organizationId: org.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true, items: true, kind: true, categoryId: true },
    }),
    jobCategories(org.id),
  ]);

  // Every category, hidden built-ins included, to name what a list is on;
  // only the ones in use are offered for a new one.
  const all = categoryOptions({
    categories,
    hiddenKinds: [],
    jobLabel: org.labelJobSingular,
    jobPlural: org.labelJobPlural,
  });
  const hidden = parseHiddenKinds(org.hiddenJobKinds);
  const label = (value: string) => all.find((option) => option.value === value)?.label ?? null;

  const checklists = templates.map((template) => {
    const appliesTo =
      template.categoryId || template.kind
        ? categoryValue({ kind: template.kind ?? "JOB", categoryId: template.categoryId })
        : "";
    return {
      id: template.id,
      name: template.name,
      items: readChecklistItems(template.items),
      appliesTo,
      appliesToLabel: appliesTo ? label(appliesTo) : null,
    };
  });

  const inUse = new Set(checklists.map((checklist) => checklist.appliesTo));
  const options: AppliesToOption[] = all
    .filter((option) => option.custom || !hidden.includes(option.value as never) || inUse.has(option.value))
    .map((option) => ({ value: option.value, label: option.label }));

  return (
    <ChecklistSettingsForm
      checklists={checklists}
      options={options}
      readOnly={!can(user, "settings:write")}
    />
  );
}

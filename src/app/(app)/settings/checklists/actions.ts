"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import {
  CHECKLIST_MAX_ITEMS,
  CHECKLIST_NAME_MAX,
  MAX_CHECKLISTS,
  parseChecklistLines,
} from "@/lib/checklists";
import { prisma } from "@/lib/db";
import { parseCategoryValue } from "@/lib/job-categories";

/**
 * Saved checklists. Settings, so settings:write guards them: what every new
 * job in a category starts with is the owner's call.
 */

const checklistSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give it a name.")
    .max(CHECKLIST_NAME_MAX, `Keep it under ${CHECKLIST_NAME_MAX} characters.`),
  items: z
    .array(z.string())
    .min(1, "Put at least one item on it, one per line.")
    .max(CHECKLIST_MAX_ITEMS, `A checklist holds up to ${CHECKLIST_MAX_ITEMS} items.`),
});

/** Adds a checklist, or saves one being edited when the form carries an id. */
export async function saveChecklistTemplate(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { org } = await requirePermission("settings:write");

  const parsed = checklistSchema.safeParse({
    name: formData.get("name") ?? "",
    items: parseChecklistLines(String(formData.get("items") ?? "")),
  });
  if (!parsed.success) return invalid(parsed.error);
  const { name, items } = parsed.data;
  const id = text(formData, "id");

  // Which category's new entries get it by themselves, if any.
  const appliesTo = text(formData, "appliesTo");
  let kind: string | null = null;
  let categoryId: string | null = null;
  if (appliesTo) {
    const choice = parseCategoryValue(appliesTo);
    if (choice?.kind) kind = choice.kind;
    else if (choice?.categoryId) {
      const category = await prisma.jobCategory.findFirst({
        where: { id: choice.categoryId, organizationId: org.id },
        select: { id: true },
      });
      if (!category) {
        return { ok: false, fieldErrors: { appliesTo: "That category has been deleted. Pick another." } };
      }
      categoryId = category.id;
    }
  }

  const existing = await prisma.checklistTemplate.findMany({
    where: { organizationId: org.id },
    select: { id: true, name: true },
  });
  const wanted = name.toLocaleLowerCase();
  const twin = existing.find((row) => row.id !== id && row.name.toLocaleLowerCase() === wanted);
  if (twin) return { ok: false, fieldErrors: { name: `You already have ${twin.name}.` } };

  const data = { name, items: JSON.stringify(items), kind, categoryId };

  if (!id) {
    if (existing.length >= MAX_CHECKLISTS) {
      return failed(`A business can keep up to ${MAX_CHECKLISTS} checklists. Delete one you no longer use first.`);
    }
    await prisma.checklistTemplate.create({ data: { organizationId: org.id, ...data } });
    revalidatePath("/settings/checklists");
    return saved(`Added ${name}.`);
  }

  if (!existing.some((row) => row.id === id)) {
    return failed("That checklist was deleted. Refresh the page to see the list as it is now.");
  }

  // Jobs already carry their own copy; this changes the ones booked from now.
  await prisma.checklistTemplate.update({ where: { id }, data });
  revalidatePath("/settings/checklists");
  return saved("Saved.");
}

/** Deletes a saved checklist. Jobs that already have its items keep them. */
export async function deleteChecklistTemplate(formData: FormData) {
  const { org } = await requirePermission("settings:write");
  const id = text(formData, "id");
  if (!id) return;

  await prisma.checklistTemplate.deleteMany({ where: { id, organizationId: org.id } });
  revalidatePath("/settings/checklists");
}

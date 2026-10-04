"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  failed,
  invalid,
  saved,
  text,
  type ActionState,
} from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import {
  CATEGORY_ICONS,
  JOB_CATEGORY_NAME_MAX,
  JOB_KIND_META,
  JOB_KINDS,
  MAX_JOB_CATEGORIES,
  type JobKind,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { serializeBillRoles } from "@/lib/bills-calendar";
import { parseHiddenKinds, serializeHiddenKinds } from "@/lib/job-categories";

/**
 * Calendar categories: a business's own, and which built-ins it offers.
 *
 * Settings, so settings:write guards them, the same as renaming a job. The
 * list is what everybody picks from, which is the owner's call rather than
 * whoever happens to be booking.
 */

function refresh() {
  revalidatePath("/settings/calendar");
  revalidatePath("/schedule");
  revalidatePath("/jobs");
}

const categorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give it a name.")
    .max(JOB_CATEGORY_NAME_MAX, `Keep it under ${JOB_CATEGORY_NAME_MAX} characters.`),
  icon: z.enum(CATEGORY_ICONS, { error: "Pick a mark for it." }),
  countsAsWork: z.boolean(),
});

/** Adds a category, or saves one being edited when the form carries an id. */
export async function saveJobCategory(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("settings:write");

  const parsed = categorySchema.safeParse({
    name: formData.get("name") ?? "",
    icon: formData.get("icon") ?? "",
    countsAsWork: formData.get("countsAsWork") === "on",
  });
  if (!parsed.success) return invalid(parsed.error);

  const id = text(formData, "id");
  const { name, icon, countsAsWork } = parsed.data;
  const kind: JobKind = countsAsWork ? "JOB" : "OTHER";

  // A second "Meeting" beside the built-in one would be two chips that look
  // the same and file differently. Compared without case, because "meeting"
  // and "Meeting" read as the same thing in a picker.
  const wanted = name.toLocaleLowerCase();
  const builtIn = JOB_KINDS.find(
    (option) =>
      (option === "JOB" ? org.labelJobSingular : JOB_KIND_META[option].label)
        .toLocaleLowerCase() === wanted,
  );
  if (builtIn) {
    const hidden = parseHiddenKinds(org.hiddenJobKinds).includes(builtIn);
    return {
      ok: false,
      fieldErrors: {
        name: hidden
          ? `${name} is a built-in category you turned off. Turn it back on above instead.`
          : `${name} is already a built-in category.`,
      },
    };
  }

  const existing = await prisma.jobCategory.findMany({
    where: { organizationId: org.id },
    select: { id: true, name: true },
  });
  const twin = existing.find(
    (category) =>
      category.id !== id && category.name.toLocaleLowerCase() === wanted,
  );
  if (twin) {
    return { ok: false, fieldErrors: { name: `You already have ${twin.name}.` } };
  }

  if (!id) {
    if (existing.length >= MAX_JOB_CATEGORIES) {
      return failed(
        `A business can have up to ${MAX_JOB_CATEGORIES} of its own categories. Delete one you no longer use first.`,
      );
    }

    await prisma.jobCategory.create({
      data: { organizationId: org.id, name, icon, kind },
    });

    refresh();
    return saved(`Added ${name}.`);
  }

  if (!existing.some((category) => category.id === id)) {
    return failed("That category was deleted. Refresh the page to see the list as it is now.");
  }

  await prisma.$transaction([
    prisma.jobCategory.update({ where: { id }, data: { name, icon, kind } }),
    // Entries store the kind they behave as, so a category that now counts
    // as work, or no longer does, takes everything filed under it along.
    prisma.job.updateMany({
      where: { organizationId: org.id, categoryId: id },
      data: { kind },
    }),
  ]);

  refresh();
  return saved("Saved.");
}

/**
 * Deletes a category. What was filed under it stays, reading as the built-in
 * it behaved as — Other, or the business's word for a job.
 *
 * The link is cleared here rather than left to the foreign key: a desktop
 * database that gained the column in an upgrade has no constraint behind it.
 */
export async function deleteJobCategory(formData: FormData) {
  const { org } = await requirePermission("settings:write");

  const id = text(formData, "id");
  if (!id) return;

  await prisma.$transaction([
    prisma.job.updateMany({
      where: { organizationId: org.id, categoryId: id },
      data: { categoryId: null },
    }),
    // A checklist that went on this category's entries goes back to being
    // put on by hand.
    prisma.checklistTemplate.updateMany({
      where: { organizationId: org.id, categoryId: id },
      data: { categoryId: null },
    }),
    prisma.jobCategory.deleteMany({ where: { id, organizationId: org.id } }),
  ]);

  refresh();
}

/** Puts a built-in category in the picker, or takes it out. */
export async function setBuiltInShown(formData: FormData) {
  const { org } = await requirePermission("settings:write");

  const kind = String(formData.get("kind") ?? "");
  if (kind === "JOB" || !(JOB_KINDS as readonly string[]).includes(kind)) return;
  const shown = String(formData.get("shown") ?? "") === "true";

  // Read fresh rather than from the context, so two quick toggles do not
  // each write back a list that has lost the other.
  const current = await prisma.organization.findUnique({
    where: { id: org.id },
    select: { hiddenJobKinds: true },
  });
  const hidden = parseHiddenKinds(current?.hiddenJobKinds);
  const next = shown
    ? hidden.filter((entry) => entry !== kind)
    : [...hidden, kind as JobKind];

  await prisma.organization.update({
    where: { id: org.id },
    data: { hiddenJobKinds: serializeHiddenKinds(next) },
  });

  refresh();
}

/** Which roles see repeating bills on the calendar, on their due dates. */
export async function setBillsOnCalendar(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { org } = await requirePermission("settings:write");
  const roles = serializeBillRoles(formData.getAll("roles").map(String));

  await prisma.organization.update({
    where: { id: org.id },
    data: { billsOnCalendarRoles: roles },
  });

  refresh();
  return saved(roles ? "Saved." : "Saved. Bills are off the calendar for everyone.");
}

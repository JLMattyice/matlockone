"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { CHECKLIST_MAX_ITEMS, parseChecklistLines, readChecklistItems } from "@/lib/checklists";
import { prisma } from "@/lib/db";
import { addItemsToJob } from "@/lib/job-checklist";
import { jobVisibilityWhere, type Actor } from "@/lib/permissions";

/**
 * A job's checklist.
 *
 * Ticking is field work, so it rides on jobs:log-time like logging hours and
 * notes, and the crew can tick only jobs they can see. Changing what is on
 * the list is editing the job, so that takes jobs:write.
 */

async function visibleJob(organizationId: string, viewer: Actor, jobId: string) {
  return prisma.job.findFirst({
    where: { id: jobId, organizationId, ...jobVisibilityWhere(viewer) },
    select: { id: true },
  });
}

/** Ticks an item or clears it. Returns false when it could not be found. */
export async function setChecklistItemDone(itemId: string, done: boolean): Promise<{ ok: boolean }> {
  const { user, org } = await requirePermission("jobs:log-time");

  const item = await prisma.jobChecklistItem.findFirst({
    where: { id: String(itemId), organizationId: org.id, job: jobVisibilityWhere(user) },
    select: { id: true, jobId: true, doneAt: true },
  });
  if (!item) return { ok: false };

  // Ticking a ticked item again keeps who did it first.
  if (done !== Boolean(item.doneAt)) {
    await prisma.jobChecklistItem.update({
      where: { id: item.id },
      data: done ? { doneAt: new Date(), doneById: user.id } : { doneAt: null, doneById: null },
    });
  }

  revalidatePath(`/jobs/${item.jobId}`);
  return { ok: true };
}

/** Adds items typed on the job, one per line. */
export async function addChecklistItems(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:write");

  const job = await visibleJob(org.id, user, String(formData.get("jobId") ?? ""));
  if (!job) return failed("That job no longer exists.");

  const labels = parseChecklistLines(text(formData, "items") ?? "");
  if (labels.length === 0) return { ok: false, fieldErrors: { items: "Type an item to add." } };

  const added = await addItemsToJob(prisma, { organizationId: org.id, jobId: job.id, labels });
  revalidatePath(`/jobs/${job.id}`);

  if (added === 0) {
    const count = await prisma.jobChecklistItem.count({ where: { jobId: job.id } });
    return failed(
      count >= CHECKLIST_MAX_ITEMS
        ? `A checklist holds up to ${CHECKLIST_MAX_ITEMS} items.`
        : "Already on the list.",
    );
  }
  return saved(added === 1 ? "Added." : `Added ${added} items.`);
}

/** Puts one of the business's saved checklists on the job. */
export async function applyChecklistTemplate(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:write");

  const job = await visibleJob(org.id, user, String(formData.get("jobId") ?? ""));
  if (!job) return failed("That job no longer exists.");

  const template = await prisma.checklistTemplate.findFirst({
    where: { id: String(formData.get("templateId") ?? ""), organizationId: org.id },
    select: { name: true, items: true },
  });
  if (!template) return failed("Pick a checklist to add.");

  const added = await addItemsToJob(prisma, {
    organizationId: org.id,
    jobId: job.id,
    labels: readChecklistItems(template.items),
  });
  revalidatePath(`/jobs/${job.id}`);

  return added === 0
    ? saved(`Everything on ${template.name} is already here.`)
    : saved(`Added ${template.name}.`);
}

export async function removeChecklistItem(itemId: string): Promise<{ ok: boolean }> {
  const { user, org } = await requirePermission("jobs:write");

  const item = await prisma.jobChecklistItem.findFirst({
    where: { id: String(itemId), organizationId: org.id, job: jobVisibilityWhere(user) },
    select: { id: true, jobId: true },
  });
  if (!item) return { ok: false };

  await prisma.jobChecklistItem.delete({ where: { id: item.id } });
  revalidatePath(`/jobs/${item.jobId}`);
  return { ok: true };
}

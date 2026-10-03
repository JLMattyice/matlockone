import "server-only";

import { CHECKLIST_MAX_ITEMS, readChecklistItems } from "./checklists";
import { prisma } from "./db";
import type { Prisma } from "@/generated/prisma/client";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Copies items onto a job, after any it already has.
 *
 * A line the job already carries — the same words, whatever the case — is
 * skipped, so putting on a second list that shares "After photos" with the
 * first does not ask for them twice. Returns how many were added.
 */
export async function addItemsToJob(
  db: Db,
  { organizationId, jobId, labels }: { organizationId: string; jobId: string; labels: string[] },
): Promise<number> {
  const existing = await db.jobChecklistItem.findMany({
    where: { jobId },
    select: { label: true, sortOrder: true },
  });
  const have = new Set(existing.map((item) => item.label.toLocaleLowerCase()));
  const room = CHECKLIST_MAX_ITEMS - existing.length;
  let next = existing.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;

  const fresh: string[] = [];
  for (const label of labels) {
    const key = label.toLocaleLowerCase();
    if (have.has(key)) continue;
    have.add(key);
    fresh.push(label);
  }
  const adding = fresh.slice(0, Math.max(room, 0));
  if (adding.length === 0) return 0;

  await db.jobChecklistItem.createMany({
    data: adding.map((label) => ({ organizationId, jobId, label, sortOrder: next++ })),
  });
  return adding.length;
}

/**
 * The saved checklists that go on new entries of a category by themselves.
 *
 * A built-in kind matches only entries not filed under a business's own
 * category, the same rule the calendar filters use.
 */
export async function checklistsForCategory(
  db: Db,
  organizationId: string,
  category: { kind: string; categoryId: string | null },
) {
  return db.checklistTemplate.findMany({
    where: {
      organizationId,
      ...(category.categoryId ? { categoryId: category.categoryId } : { kind: category.kind, categoryId: null }),
    },
    orderBy: { name: "asc" },
    select: { items: true },
  });
}

/** Puts the category's own checklists on a job. Returns how many items went on. */
export async function attachCategoryChecklists(
  db: Db,
  job: { organizationId: string; jobId: string; kind: string; categoryId: string | null },
): Promise<number> {
  const templates = await checklistsForCategory(db, job.organizationId, job);
  if (templates.length === 0) return 0;
  return addItemsToJob(db, {
    organizationId: job.organizationId,
    jobId: job.jobId,
    labels: templates.flatMap((template) => readChecklistItems(template.items)),
  });
}

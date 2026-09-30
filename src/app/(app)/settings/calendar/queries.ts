import "server-only";

import { prisma } from "@/lib/db";

/** A business's own calendar categories, for the job form and the filters. */
export async function jobCategories(organizationId: string) {
  return prisma.jobCategory.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, icon: true, kind: true },
  });
}

/**
 * Everything the Calendar settings screen shows: the business's categories,
 * and how many entries sit under each built-in and each of its own.
 *
 * The counts are there so hiding a built-in or deleting a category is done
 * knowing what it touches.
 */
export async function calendarSettings(organizationId: string) {
  const [categories, builtIn] = await Promise.all([
    prisma.jobCategory.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        icon: true,
        kind: true,
        _count: { select: { jobs: true } },
      },
    }),
    prisma.job.groupBy({
      by: ["kind"],
      where: { organizationId, categoryId: null },
      _count: { _all: true },
    }),
  ]);

  return {
    categories: categories.map(({ _count, ...category }) => ({
      ...category,
      entries: _count.jobs,
    })),
    builtInCounts: Object.fromEntries(
      builtIn.map((row) => [row.kind, row._count._all]),
    ) as Record<string, number>,
  };
}

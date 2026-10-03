import "server-only";

import { prisma } from "@/lib/db";

/**
 * The names already in the price book, archived ones included: re-importing
 * an old price list should not bring back something deliberately retired.
 */
export async function catalogNames(organizationId: string): Promise<string[]> {
  const items = await prisma.priceBookItem.findMany({
    where: { organizationId },
    select: { name: true },
  });
  return items.map((item) => item.name);
}

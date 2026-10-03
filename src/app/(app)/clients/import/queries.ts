import "server-only";

import { matchKeys } from "@/lib/client-import";
import { prisma } from "@/lib/db";

/**
 * How every customer already on file is recognised, for spotting them in an
 * imported list. Archived ones count: re-importing an old spreadsheet should
 * not bring back somebody the business deliberately put away.
 */
export async function onFileKeys(organizationId: string): Promise<string[]> {
  const clients = await prisma.client.findMany({
    where: { organizationId },
    select: { displayName: true, email: true, phone: true, mobilePhone: true },
  });
  return [...new Set(clients.flatMap(matchKeys))];
}

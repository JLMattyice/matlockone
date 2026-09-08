import "server-only";

import type { Prisma } from "@/generated/prisma/client";

export type DocumentKind = "job" | "estimate" | "invoice";

const COUNTERS = {
  job: { counter: "jobNextNumber", prefix: "jobPrefix" },
  estimate: { counter: "estimateNextNumber", prefix: "estimatePrefix" },
  invoice: { counter: "invoiceNextNumber", prefix: "invoicePrefix" },
} as const;

/**
 * Allocates the next document number for an organization.
 *
 * The counter is bumped with an atomic `increment` rather than read-then-write,
 * so two people creating a job at the same moment cannot be handed the same
 * number. `update` returns the row *after* the increment, so the number just
 * allocated is one less than what comes back.
 *
 * Must be called inside the same transaction that creates the record — a
 * rollback then gives the number back instead of burning it.
 */
export async function allocateNumber(
  tx: Prisma.TransactionClient,
  organizationId: string,
  kind: DocumentKind,
): Promise<string> {
  const { counter, prefix } = COUNTERS[kind];

  const org = await tx.organization.update({
    where: { id: organizationId },
    data: { [counter]: { increment: 1 } },
    select: { [counter]: true, [prefix]: true },
  });

  const record = org as unknown as Record<string, number | string>;
  const allocated = Number(record[counter]) - 1;

  return `${record[prefix]}${allocated}`;
}

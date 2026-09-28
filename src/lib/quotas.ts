import "server-only";

import { entitlement, storageAllowance, type BillingFields } from "@/lib/billing/entitlement";
import { dataStaysOnThisMachine } from "@/lib/config";
import { prisma } from "@/lib/db";
import { formatBytes } from "@/lib/storage-limits";

/**
 * How much one business may keep, so one account cannot fill the store that
 * every business shares.
 *
 * Files are the one thing that grows without anybody noticing — a crew
 * photographing every job — and the one thing the hosted deployment pays for
 * by the gigabyte. Each plan carries an allowance (plans.ts). A desktop install
 * that keeps its own files is not counted: they are on its own disk.
 *
 * A soft cap. Two uploads at the same moment can each see the room the other
 * is about to take, and together go a file past it; that is not worth a lock.
 * Nothing already stored is ever removed or hidden for being over — a business
 * that moves to a smaller plan simply cannot add more until it is back under.
 */

/**
 * Everything the business has stored, in bytes.
 *
 * Summed by the database and handed back as text. sizeBytes is a 32-bit
 * column — fine for one file of at most 15 MB — but a business's total passes
 * 2 GB long before it reaches its allowance, and Prisma types _sum of an Int
 * as that same Int. Whether a larger total survives the trip depends on the
 * database and driver; a sum cast to text in SQL does not, and CAST(… AS
 * TEXT) reads the same on Postgres and on a desktop install's SQLite.
 */
export async function storageUsed(organizationId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ total: string | number | null }[]>`
    SELECT CAST(COALESCE(SUM("sizeBytes"), 0) AS TEXT) AS "total"
    FROM "Attachment"
    WHERE "organizationId" = ${organizationId}
  `;
  return Number(rows[0]?.total ?? 0);
}

export type StorageUsage = { used: number; allowance: number | null; planName: string | null };

/** For the screens that show it: used, and of how much. */
export async function storageUsage(org: BillingFields & { id: string }): Promise<StorageUsage> {
  const limit = dataStaysOnThisMachine() ? null : storageAllowance(entitlement(org));
  return {
    used: await storageUsed(org.id),
    allowance: limit?.bytes ?? null,
    planName: limit?.planName ?? null,
  };
}

export type StorageRoom = {
  /**
   * Reserves room for a file, or says why there is none. Called once per file
   * in a batch, so ten photos that would together go past the allowance stop
   * at the one that does.
   */
  take(bytes: number): string | null;
};

export function storageFullMessage(usage: { used: number; allowance: number; planName: string }) {
  return (
    `That would go past the ${usage.planName} plan’s ${formatBytes(usage.allowance)} of files ` +
    `(${formatBytes(usage.used)} used). Delete files you no longer need, or move to a larger plan under Billing.`
  );
}

/** The room left for this business's uploads, read once per request. */
export async function storageRoom(org: BillingFields & { id: string }): Promise<StorageRoom> {
  const usage = await storageUsage(org);
  const { allowance, planName } = usage;
  if (allowance === null || planName === null) return { take: () => null };

  let used = usage.used;
  return {
    take(bytes) {
      if (used + bytes > allowance) return storageFullMessage({ used, allowance, planName });
      used += bytes;
      return null;
    },
  };
}

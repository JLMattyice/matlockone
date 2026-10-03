import "server-only";

import { QUICKBOOKS, type QuickBooksConnection } from "./connection";
import { prisma } from "../db";

/**
 * The remembered twin of each record in the connected QuickBooks company.
 * One row per record per company; see the AccountingLink model.
 */

export type EntityType =
  | "CLIENT"
  | "INVOICE"
  | "PAYMENT"
  | "EXPENSE"
  | "ITEM"
  | "ITEM_KIND"
  | "VENDOR";

export type Link = {
  entityId: string;
  externalId: string | null;
  syncToken: string | null;
  origin: string;
  remoteStatus: string;
  syncedAt: Date | null;
  lastTriedAt: Date | null;
  lastError: string | null;
};

export type LinkChange = {
  externalId?: string | null;
  syncToken?: string | null;
  origin?: string;
  remoteStatus?: string;
  syncedAt?: Date | null;
  lastTriedAt?: Date;
  lastError?: string | null;
};

function key(connection: QuickBooksConnection, entityType: EntityType, entityId: string) {
  return {
    organizationId_provider_realmId_entityType_entityId: {
      organizationId: connection.organizationId,
      provider: QUICKBOOKS,
      realmId: connection.realmId,
      entityType,
      entityId,
    },
  };
}

/** Every link of one kind for this company, by the record they belong to. */
export async function linksFor(
  connection: QuickBooksConnection,
  entityType: EntityType,
  entityIds?: string[],
): Promise<Map<string, Link>> {
  const rows = await prisma.accountingLink.findMany({
    where: {
      organizationId: connection.organizationId,
      provider: QUICKBOOKS,
      realmId: connection.realmId,
      entityType,
      ...(entityIds ? { entityId: { in: entityIds } } : {}),
    },
  });
  return new Map(rows.map((row) => [row.entityId, row]));
}

export async function linkFor(
  connection: QuickBooksConnection,
  entityType: EntityType,
  entityId: string,
): Promise<Link | null> {
  return prisma.accountingLink.findUnique({ where: key(connection, entityType, entityId) });
}

export async function saveLink(
  connection: QuickBooksConnection,
  entityType: EntityType,
  entityId: string,
  change: LinkChange,
) {
  await prisma.accountingLink.upsert({
    where: key(connection, entityType, entityId),
    create: {
      organizationId: connection.organizationId,
      provider: QUICKBOOKS,
      realmId: connection.realmId,
      entityType,
      entityId,
      ...change,
    },
    update: change,
  });
}

export async function dropLink(connection: QuickBooksConnection, entityType: EntityType, entityId: string) {
  await prisma.accountingLink.deleteMany({
    where: {
      organizationId: connection.organizationId,
      provider: QUICKBOOKS,
      realmId: connection.realmId,
      entityType,
      entityId,
    },
  });
}

/** A failure, kept short enough for the settings page. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "Something went wrong sending this.";
  return message.slice(0, 500);
}

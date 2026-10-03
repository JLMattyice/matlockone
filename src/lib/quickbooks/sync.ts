import "server-only";

import { after } from "next/server";

import { QuickBooksError } from "./api";
import {
  ACCOUNTING_KIND,
  loadConnection,
  QUICKBOOKS,
  type QuickBooksConnection,
} from "./connection";
import { pushCustomer, type ClientForQuickBooks } from "./customers";
import { entitlement } from "../billing/entitlement";
import { prisma } from "../db";

/**
 * Keeping QuickBooks up to date with the customers here.
 *
 * Every customer that is not archived goes over, and goes over again whenever
 * it changes. "Changed" is read from the customer's and its addresses'
 * updatedAt against when it last arrived, so nothing has to remember to mark
 * a customer dirty — an edit anywhere is enough.
 *
 * Three things start a send: saving a customer (in the background, after the
 * page has answered), the morning run, and Send now. All three are the same
 * call and all three are safe to repeat; a customer already up to date is not
 * sent.
 */

export const CLIENT_ENTITY = "CLIENT";

const CLIENT_SELECT = {
  id: true,
  type: true,
  displayName: true,
  firstName: true,
  lastName: true,
  businessName: true,
  email: true,
  phone: true,
  mobilePhone: true,
  website: true,
  updatedAt: true,
  addresses: {
    select: {
      id: true,
      line1: true,
      line2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      isPrimary: true,
      isBilling: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

type ClientRow = Omit<ClientForQuickBooks, "addresses"> & {
  updatedAt: Date;
  addresses: (ClientForQuickBooks["addresses"][number] & { updatedAt: Date })[];
};

/** When the customer, or any address of it, last changed. */
function changedAt(client: ClientRow): number {
  return Math.max(client.updatedAt.getTime(), ...client.addresses.map((a) => a.updatedAt.getTime()));
}

export type CustomerSyncResult = {
  sent: number;
  failed: number;
  /** Still waiting when the time ran out. */
  remaining: number;
  /** Why nothing was tried at all. */
  skipped?: "not-connected" | "reconnect" | "not-started";
};

/**
 * Sends whatever customers are new or changed, oldest first, for as long as
 * `budgetMs` allows. `clientIds` narrows it to those customers — the save
 * that just happened.
 *
 * Nothing goes over until the owner has pressed Send now once (`firstSentAt`),
 * unless `start` says this is that press.
 */
export async function syncCustomers(
  organizationId: string,
  options: { clientIds?: string[]; budgetMs?: number; start?: boolean; now?: () => Date } = {},
): Promise<CustomerSyncResult> {
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const budgetMs = options.budgetMs ?? 20_000;

  const connection = await loadConnection(organizationId);
  if (!connection) return { sent: 0, failed: 0, remaining: 0, skipped: "not-connected" };
  if (connection.needsReconnect) return { sent: 0, failed: 0, remaining: 0, skipped: "reconnect" };
  if (!connection.firstSentAt && !options.start) {
    return { sent: 0, failed: 0, remaining: 0, skipped: "not-started" };
  }

  const pending = await pendingCustomers(connection, options.clientIds);
  const result: CustomerSyncResult = { sent: 0, failed: 0, remaining: pending.length };

  for (const { client, link } of pending) {
    if (Date.now() - started > budgetMs) break;

    // Read before sending: an edit that lands while this one is in flight
    // is newer than this mark, and goes over next time.
    const attemptAt = now();
    try {
      const outcome = await pushCustomer(connection, client, link);
      await saveLink(connection, client.id, {
        externalId: outcome.externalId,
        syncToken: outcome.syncToken,
        origin: outcome.origin,
        syncedAt: attemptAt,
        lastTriedAt: attemptAt,
        lastError: null,
      });
      result.sent++;
    } catch (error) {
      const message =
        error instanceof QuickBooksError || error instanceof Error
          ? error.message
          : "Something went wrong sending this customer.";
      await saveLink(connection, client.id, { lastTriedAt: attemptAt, lastError: message.slice(0, 500) });
      result.failed++;
      // Nothing else will get through until the owner connects again.
      if (error instanceof QuickBooksError && error.reconnect) break;
    }
    result.remaining--;
  }

  return result;
}

/** Customers that are not archived and are new to QuickBooks or changed since. */
async function pendingCustomers(connection: QuickBooksConnection, clientIds?: string[]) {
  const clients = (await prisma.client.findMany({
    where: {
      organizationId: connection.organizationId,
      status: { not: "ARCHIVED" },
      ...(clientIds ? { id: { in: clientIds } } : {}),
    },
    select: CLIENT_SELECT,
  })) as ClientRow[];

  const links = await prisma.accountingLink.findMany({
    where: {
      organizationId: connection.organizationId,
      provider: QUICKBOOKS,
      realmId: connection.realmId,
      entityType: CLIENT_ENTITY,
      ...(clientIds ? { entityId: { in: clientIds } } : {}),
    },
  });
  const byClient = new Map(links.map((link) => [link.entityId, link]));

  return clients
    .map((client) => ({ client, link: byClient.get(client.id) ?? null }))
    .filter(({ client, link }) => !link?.syncedAt || link.syncedAt.getTime() < changedAt(client))
    .sort((a, b) => {
      // Never tried first, then whatever has waited longest.
      const tried = (x: typeof a) => x.link?.lastTriedAt?.getTime() ?? 0;
      return tried(a) - tried(b) || changedAt(a.client) - changedAt(b.client);
    });
}

async function saveLink(
  connection: QuickBooksConnection,
  clientId: string,
  data: {
    externalId?: string;
    syncToken?: string | null;
    origin?: string;
    syncedAt?: Date;
    lastTriedAt: Date;
    lastError: string | null;
  },
) {
  await prisma.accountingLink.upsert({
    where: {
      provider_realmId_entityType_entityId: {
        provider: QUICKBOOKS,
        realmId: connection.realmId,
        entityType: CLIENT_ENTITY,
        entityId: clientId,
      },
    },
    create: {
      organizationId: connection.organizationId,
      provider: QUICKBOOKS,
      realmId: connection.realmId,
      entityType: CLIENT_ENTITY,
      entityId: clientId,
      ...data,
    },
    update: data,
  });
}

/**
 * Sends these customers in the background once the page has answered, so a
 * save never waits on QuickBooks. Does nothing for a business that has no
 * QuickBooks connection — the one query it costs every save.
 */
export async function sendCustomersSoon(organizationId: string, clientIds: string[]) {
  if (clientIds.length === 0) return;
  const connected = await prisma.integration.count({
    where: { organizationId, kind: ACCOUNTING_KIND, provider: QUICKBOOKS, isActive: true },
  });
  if (connected === 0) return;

  after(async () => {
    try {
      await syncCustomers(organizationId, { clientIds, budgetMs: 15_000 });
    } catch (error) {
      console.error(`[quickbooks] background send for ${organizationId} failed:`, error);
    }
  });
}

export type QuickBooksSweep = {
  businesses: number;
  sent: number;
  failed: number;
  stoppedEarly: boolean;
};

/**
 * The morning run: every connected business that is paid up and has started
 * sending gets whatever is waiting — including anything a background send
 * could not deliver yesterday.
 */
export async function sweepQuickBooks(
  options: { budgetMs?: number; now?: Date } = {},
): Promise<QuickBooksSweep> {
  const started = Date.now();
  const budgetMs = options.budgetMs ?? 20_000;
  const result: QuickBooksSweep = { businesses: 0, sent: 0, failed: 0, stoppedEarly: false };

  const integrations = await prisma.integration.findMany({
    where: {
      kind: ACCOUNTING_KIND,
      provider: QUICKBOOKS,
      isActive: true,
      organization: { isDemo: false },
    },
    select: { organizationId: true, organization: true },
  });

  for (const { organizationId, organization } of integrations) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) {
      result.stoppedEarly = true;
      break;
    }
    if (!entitlement(organization, options.now).ok) continue;

    try {
      const outcome = await syncCustomers(organizationId, { budgetMs: left });
      if (outcome.skipped) continue;
      result.businesses++;
      result.sent += outcome.sent;
      result.failed += outcome.failed;
      if (outcome.remaining > 0) result.stoppedEarly = true;
    } catch (error) {
      result.failed++;
      console.error(`[quickbooks] morning send for ${organizationId} failed:`, error);
    }
  }

  return result;
}

/** For the settings page: how many customers are there, waiting, or failing. */
export async function customerSyncSummary(connection: QuickBooksConnection) {
  const pending = await pendingCustomers(connection);
  const sent = await prisma.accountingLink.count({
    where: {
      organizationId: connection.organizationId,
      provider: QUICKBOOKS,
      realmId: connection.realmId,
      entityType: CLIENT_ENTITY,
      syncedAt: { not: null },
    },
  });

  const failing = pending
    .filter(({ link }) => link?.lastError)
    .map(({ client, link }) => ({
      id: client.id,
      name: client.displayName,
      error: link!.lastError!,
      at: link!.lastTriedAt,
    }));

  // Waiting means not yet tried, or changed since; a customer QuickBooks
  // refused is counted with the failures, not twice.
  return { waiting: pending.length - failing.length, sent, failing };
}

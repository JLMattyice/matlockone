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
import { deleteRemovedExpense, pushExpense } from "./expenses";
import { dayOf, pushInvoice, voidDeletedInvoice, type RemoteOutcome } from "./invoices";
import { priceBookByName, type PriceBookEntry } from "./items";
import {
  dropLink,
  errorText,
  linkFor,
  linksFor,
  saveLink,
  type EntityType,
  type Link,
  type LinkChange,
} from "./links";
import { deleteRemovedPayment, pushPayment } from "./payments";
import { entitlement } from "../billing/entitlement";
import { prisma } from "../db";

/**
 * Keeping QuickBooks up to date with this business's books.
 *
 * Four kinds of record go over, in the order QuickBooks needs them: customers
 * (every one not archived), invoices once they leave draft, their payments,
 * and expenses whose category has an account chosen. Invoices and expenses
 * dated before the connection's start date stay behind — they are presumed
 * to be in the books already. Whatever was sent and is later deleted here is
 * voided or deleted there.
 *
 * "Changed" is read from each record's updatedAt against when it last went
 * over, so nothing has to remember to mark a record dirty. Saving, the
 * morning run and Send now all make the same call; a record already up to
 * date is not sent again.
 */

export const CLIENT_ENTITY = "CLIENT";

export type SyncScope = {
  clients?: string[];
  invoices?: string[];
  payments?: string[];
  expenses?: string[];
  /** Void or delete there whatever was deleted here. */
  cleanup?: boolean;
};

export type SyncKind = "customers" | "invoices" | "payments" | "expenses";

export type SyncResult = {
  sent: number;
  failed: number;
  /** Still waiting when the time ran out. */
  remaining: number;
  /** Why nothing was tried at all. */
  skipped?: "not-connected" | "reconnect" | "not-started";
  kinds: Record<SyncKind, { sent: number; failed: number }>;
};

type Context = {
  connection: QuickBooksConnection;
  zone: string;
  deadline: number;
  now: () => Date;
  result: SyncResult;
  /** QuickBooks refused the connection: nothing more is tried this run. */
  stopped: boolean;
};

function emptyResult(skipped?: SyncResult["skipped"]): SyncResult {
  return {
    sent: 0,
    failed: 0,
    remaining: 0,
    ...(skipped ? { skipped } : {}),
    kinds: {
      customers: { sent: 0, failed: 0 },
      invoices: { sent: 0, failed: 0 },
      payments: { sent: 0, failed: 0 },
      expenses: { sent: 0, failed: 0 },
    },
  };
}

// --------------------------------------------------------------- pending ---

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
  status: true,
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
  status: string;
  updatedAt: Date;
  addresses: (ClientForQuickBooks["addresses"][number] & { updatedAt: Date })[];
};

/** When the customer, or any address of it, last changed. */
function clientChangedAt(client: ClientRow): number {
  return Math.max(client.updatedAt.getTime(), ...client.addresses.map((a) => a.updatedAt.getTime()));
}

type Pending<T> = { record: T; link: Link | null; name: string; href: string };

/** Never tried first, then whatever has waited longest. */
function byWaiting<T>(a: Pending<T>, b: Pending<T>) {
  return (a.link?.lastTriedAt?.getTime() ?? 0) - (b.link?.lastTriedAt?.getTime() ?? 0);
}

function changedSince(link: Link | null, changedAt: number) {
  return !link?.syncedAt || link.syncedAt.getTime() < changedAt || link.remoteStatus !== "ACTIVE";
}

async function pendingCustomers(connection: QuickBooksConnection, ids?: string[]) {
  const clients = (await prisma.client.findMany({
    where: {
      organizationId: connection.organizationId,
      status: { not: "ARCHIVED" },
      ...(ids ? { id: { in: ids } } : {}),
    },
    select: CLIENT_SELECT,
  })) as ClientRow[];
  const links = await linksFor(connection, "CLIENT", ids);

  return clients
    .map((record) => ({
      record,
      link: links.get(record.id) ?? null,
      name: record.displayName,
      href: `/clients/${record.id}`,
    }))
    .filter(({ record, link }) => !link?.syncedAt || link.syncedAt.getTime() < clientChangedAt(record))
    .sort(byWaiting);
}

const INVOICE_SELECT = {
  id: true,
  number: true,
  status: true,
  issueDate: true,
  dueDate: true,
  notes: true,
  discountCents: true,
  taxCents: true,
  clientId: true,
  updatedAt: true,
  client: { select: { email: true } },
  lineItems: {
    select: {
      kind: true,
      name: true,
      description: true,
      quantity: true,
      unitPriceCents: true,
      totalCents: true,
      sortOrder: true,
    },
  },
} as const;

async function pendingInvoices(connection: QuickBooksConnection, zone: string, ids?: string[]) {
  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId: connection.organizationId,
      status: { not: "DRAFT" },
      ...(ids ? { id: { in: ids } } : {}),
    },
    select: INVOICE_SELECT,
  });
  const links = await linksFor(connection, "INVOICE", ids);

  return invoices
    .filter((invoice) => dayOf(invoice.issueDate, zone) >= connection.sendFrom)
    .map((record) => ({
      record,
      link: links.get(record.id) ?? null,
      name: `Invoice ${record.number}`,
      href: `/invoices/${record.id}`,
    }))
    .filter(({ record, link }) =>
      record.status === "CANCELLED"
        ? Boolean(link?.externalId) && link!.remoteStatus === "ACTIVE"
        : changedSince(link, record.updatedAt.getTime()),
    )
    .sort(byWaiting);
}

async function pendingPayments(
  connection: QuickBooksConnection,
  zone: string,
  ids?: string[],
  invoiceIds?: string[],
) {
  const narrowed = Boolean(ids || invoiceIds);
  const payments = await prisma.payment.findMany({
    where: {
      organizationId: connection.organizationId,
      invoice: { status: { notIn: ["DRAFT", "CANCELLED"] } },
      ...(narrowed
        ? { OR: [{ id: { in: ids ?? [] } }, { invoiceId: { in: invoiceIds ?? [] } }] }
        : {}),
    },
    select: {
      id: true,
      amountCents: true,
      method: true,
      receivedAt: true,
      reference: true,
      invoice: { select: { id: true, number: true, issueDate: true, clientId: true } },
    },
  });
  const links = await linksFor(connection, "PAYMENT", narrowed ? payments.map((p) => p.id) : undefined);

  return payments
    .filter((payment) => dayOf(payment.invoice.issueDate, zone) >= connection.sendFrom)
    .map((record) => ({
      record,
      link: links.get(record.id) ?? null,
      name: `Payment on invoice ${record.invoice.number}`,
      href: `/invoices/${record.invoice.id}`,
    }))
    // A payment never changes once recorded: sent once is sent.
    .filter(({ link }) => !link?.syncedAt)
    .sort(byWaiting);
}

async function expenseRows(connection: QuickBooksConnection, ids?: string[]) {
  return prisma.expense.findMany({
    where: { organizationId: connection.organizationId, ...(ids ? { id: { in: ids } } : {}) },
    select: {
      id: true,
      description: true,
      category: true,
      vendor: true,
      amountCents: true,
      method: true,
      reference: true,
      spentAt: true,
      reimbursable: true,
      reimbursedAt: true,
      updatedAt: true,
    },
  });
}

/**
 * Expenses that go over: on or after the start date, and — when somebody
 * paid personally — once they have been paid back, which is when the money
 * actually left the business. One sent and then marked not paid back is
 * taken out again.
 */
async function pendingExpenses(connection: QuickBooksConnection, zone: string, ids?: string[]) {
  const expenses = await expenseRows(connection, ids);
  const links = await linksFor(connection, "EXPENSE", ids);
  const ready = Boolean(connection.paidFromAccountId);

  return expenses
    .filter((expense) => dayOf(expense.spentAt, zone) >= connection.sendFrom)
    .map((record) => ({
      record,
      link: links.get(record.id) ?? null,
      name: record.description,
      href: `/expenses/${record.id}`,
      withdraw: record.reimbursable && !record.reimbursedAt,
    }))
    .filter(({ record, link, withdraw }) => {
      if (withdraw) return Boolean(link?.externalId) && link!.remoteStatus === "ACTIVE";
      const mapped = ready && Boolean(connection.expenseAccounts[record.category]);
      return mapped && changedSince(link, record.updatedAt.getTime());
    })
    .sort(byWaiting);
}

// ------------------------------------------------------------------ steps ---

/**
 * Sends each pending record in turn until the time runs out, remembering
 * what came of it. A refused connection stops the whole run.
 */
async function sendEach<T extends { id: string }, P extends Pending<T>>(
  ctx: Context,
  kind: SyncKind,
  entityType: EntityType,
  pending: P[],
  push: (item: P) => Promise<LinkChange>,
) {
  ctx.result.remaining += pending.length;

  for (const item of pending) {
    if (ctx.stopped || Date.now() > ctx.deadline) return;

    // Read before sending: an edit landing while this one is in flight is
    // newer than this mark, and goes over next time.
    const attemptAt = ctx.now();
    try {
      const change = await push(item);
      await saveLink(ctx.connection, entityType, item.record.id, {
        ...change,
        syncedAt: attemptAt,
        lastTriedAt: attemptAt,
        lastError: null,
      });
      ctx.result.sent++;
      ctx.result.kinds[kind].sent++;
    } catch (error) {
      await saveLink(ctx.connection, entityType, item.record.id, {
        lastTriedAt: attemptAt,
        lastError: errorText(error),
      });
      ctx.result.failed++;
      ctx.result.kinds[kind].failed++;
      if (error instanceof QuickBooksError && error.reconnect) ctx.stopped = true;
    }
    ctx.result.remaining--;
  }
}

const outcome = (sent: RemoteOutcome): LinkChange => ({
  externalId: sent.externalId,
  syncToken: sent.syncToken,
  remoteStatus: sent.remoteStatus,
});

/**
 * The QuickBooks customer an invoice or payment is filed under, sending the
 * customer first if it has not gone yet — archived ones included, since a
 * bill still needs somebody to be billed.
 */
async function customerFor(ctx: Context, clientId: string): Promise<string> {
  const link = await linkFor(ctx.connection, "CLIENT", clientId);
  if (link?.externalId) return link.externalId;

  const client = (await prisma.client.findUnique({
    where: { id: clientId },
    select: CLIENT_SELECT,
  })) as ClientRow | null;
  if (!client) throw new QuickBooksError("Its customer no longer exists.", 400);

  const attemptAt = ctx.now();
  try {
    const sent = await pushCustomer(ctx.connection, client, link);
    await saveLink(ctx.connection, "CLIENT", clientId, {
      externalId: sent.externalId,
      syncToken: sent.syncToken,
      origin: sent.origin,
      syncedAt: attemptAt,
      lastTriedAt: attemptAt,
      lastError: null,
    });
    return sent.externalId;
  } catch (error) {
    await saveLink(ctx.connection, "CLIENT", clientId, { lastTriedAt: attemptAt, lastError: errorText(error) });
    if (error instanceof QuickBooksError && error.reconnect) throw error;
    throw new QuickBooksError(`Its customer could not be sent first. ${errorText(error)}`, 400);
  }
}

async function priceBook(organizationId: string): Promise<Map<string, PriceBookEntry>> {
  const entries = await prisma.priceBookItem.findMany({
    where: { organizationId },
    select: { id: true, name: true, kind: true },
    orderBy: { createdAt: "asc" },
  });
  return priceBookByName(entries);
}

async function customersStep(ctx: Context, ids?: string[]) {
  const pending = await pendingCustomers(ctx.connection, ids);
  await sendEach(ctx, "customers", "CLIENT", pending, async ({ record, link }) => {
    const sent = await pushCustomer(ctx.connection, record, link);
    return { externalId: sent.externalId, syncToken: sent.syncToken, origin: sent.origin };
  });
}

async function invoicesStep(ctx: Context, ids?: string[]) {
  const pending = await pendingInvoices(ctx.connection, ctx.zone, ids);
  if (pending.length === 0) return;
  const book = await priceBook(ctx.connection.organizationId);

  await sendEach(ctx, "invoices", "INVOICE", pending, async ({ record, link }) => {
    const customerId = record.status === "CANCELLED" ? "" : await customerFor(ctx, record.clientId);
    return outcome(await pushInvoice(ctx.connection, record, link, customerId, book, ctx.zone));
  });
}

async function paymentsStep(ctx: Context, ids?: string[], invoiceIds?: string[]) {
  const pending = await pendingPayments(ctx.connection, ctx.zone, ids, invoiceIds);

  await sendEach(ctx, "payments", "PAYMENT", pending, async ({ record }) => {
    const invoiceLink = await linkFor(ctx.connection, "INVOICE", record.invoice.id);
    if (!invoiceLink?.externalId || invoiceLink.remoteStatus !== "ACTIVE") {
      throw new QuickBooksError(
        `Invoice ${record.invoice.number} has not reached QuickBooks yet, so its payment waits for it.`,
        400,
      );
    }
    const customerId = await customerFor(ctx, record.invoice.clientId);
    return outcome(await pushPayment(ctx.connection, record, customerId, invoiceLink.externalId, ctx.zone));
  });
}

async function expensesStep(ctx: Context, ids?: string[]) {
  const pending = await pendingExpenses(ctx.connection, ctx.zone, ids);

  await sendEach(ctx, "expenses", "EXPENSE", pending, async ({ record, link, withdraw }) => {
    if (withdraw && link) {
      await deleteRemovedExpense(ctx.connection, link);
      return { remoteStatus: "DELETED" };
    }
    return outcome(await pushExpense(ctx.connection, record, link, ctx.zone));
  });
}

/**
 * Whatever was sent and has since been deleted here: payments deleted there
 * first (an invoice with payments on it cannot be voided), then expenses,
 * then invoices voided — kept in QuickBooks as zeros, so the numbering holds.
 */
async function cleanupStep(ctx: Context) {
  const org = ctx.connection.organizationId;

  const retire = async (
    kind: SyncKind,
    entityType: EntityType,
    stillHere: (ids: string[]) => Promise<{ id: string }[]>,
    remove: (link: Link) => Promise<void>,
  ) => {
    const links = [...(await linksFor(ctx.connection, entityType)).values()].filter(
      (link) => link.externalId && link.remoteStatus === "ACTIVE",
    );
    if (links.length === 0) return;
    const here = new Set((await stillHere(links.map((l) => l.entityId))).map((row) => row.id));

    for (const link of links.filter((l) => !here.has(l.entityId))) {
      if (ctx.stopped || Date.now() > ctx.deadline) return;
      try {
        await remove(link);
        await dropLink(ctx.connection, entityType, link.entityId);
        ctx.result.sent++;
        ctx.result.kinds[kind].sent++;
      } catch (error) {
        await saveLink(ctx.connection, entityType, link.entityId, {
          lastTriedAt: ctx.now(),
          lastError: errorText(error),
        });
        ctx.result.failed++;
        ctx.result.kinds[kind].failed++;
        if (error instanceof QuickBooksError && error.reconnect) ctx.stopped = true;
      }
    }
  };

  await retire(
    "payments",
    "PAYMENT",
    (ids) => prisma.payment.findMany({ where: { organizationId: org, id: { in: ids } }, select: { id: true } }),
    (link) => deleteRemovedPayment(ctx.connection, link),
  );
  await retire(
    "expenses",
    "EXPENSE",
    (ids) => prisma.expense.findMany({ where: { organizationId: org, id: { in: ids } }, select: { id: true } }),
    (link) => deleteRemovedExpense(ctx.connection, link),
  );
  await retire(
    "invoices",
    "INVOICE",
    (ids) => prisma.invoice.findMany({ where: { organizationId: org, id: { in: ids } }, select: { id: true } }),
    (link) => voidDeletedInvoice(ctx.connection, link),
  );
}

// ------------------------------------------------------------- the calls ---

/**
 * Sends whatever is new or changed, for as long as `budgetMs` allows. A
 * `scope` narrows it to the records a save just touched.
 *
 * Nothing goes over until the owner has pressed Send now once
 * (`firstSentAt`), unless `start` says this is that press.
 */
export async function syncQuickBooks(
  organizationId: string,
  options: { scope?: SyncScope; budgetMs?: number; start?: boolean; now?: () => Date } = {},
): Promise<SyncResult> {
  const connection = await loadConnection(organizationId);
  if (!connection) return emptyResult("not-connected");
  if (connection.needsReconnect) return emptyResult("reconnect");
  if (!connection.firstSentAt && !options.start) return emptyResult("not-started");

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { timeZone: true },
  });

  const ctx: Context = {
    connection,
    zone: org?.timeZone ?? "UTC",
    deadline: Date.now() + (options.budgetMs ?? 20_000),
    now: options.now ?? (() => new Date()),
    result: emptyResult(),
    stopped: false,
  };

  const scope = options.scope;
  const everything = !scope;

  if (everything || scope.clients) await customersStep(ctx, scope?.clients);
  if (everything || scope.invoices) await invoicesStep(ctx, scope?.invoices);
  if (everything || scope.payments || scope.invoices) {
    await paymentsStep(ctx, scope?.payments, scope?.invoices);
  }
  if (everything || scope.expenses) await expensesStep(ctx, scope?.expenses);
  if (everything || scope.cleanup) await cleanupStep(ctx);

  return ctx.result;
}

/** Customers only — what a customer save asks for. */
export function syncCustomers(
  organizationId: string,
  options: { clientIds?: string[]; budgetMs?: number; start?: boolean; now?: () => Date } = {},
) {
  return syncQuickBooks(organizationId, {
    ...options,
    scope: options.clientIds ? { clients: options.clientIds } : undefined,
  });
}

/**
 * Sends what a save just touched — or, with no scope, everything waiting —
 * in the background once the page has answered, so a save never waits on
 * QuickBooks. Does nothing for a business without a QuickBooks connection:
 * the one query it costs every save.
 */
export async function sendToQuickBooksSoon(organizationId: string, scope?: SyncScope) {
  const connected = await prisma.integration.count({
    where: { organizationId, kind: ACCOUNTING_KIND, provider: QUICKBOOKS, isActive: true },
  });
  if (connected === 0) return;

  after(async () => {
    try {
      await syncQuickBooks(organizationId, { scope, budgetMs: 15_000 });
    } catch (error) {
      console.error(`[quickbooks] background send for ${organizationId} failed:`, error);
    }
  });
}

export function sendCustomersSoon(organizationId: string, clientIds: string[]) {
  if (clientIds.length === 0) return Promise.resolve();
  return sendToQuickBooksSoon(organizationId, { clients: clientIds });
}

export type QuickBooksSweep = {
  businesses: number;
  sent: number;
  failed: number;
  stoppedEarly: boolean;
};

/**
 * The morning run: every connected business that is paid up and has started
 * sending gets whatever is waiting — including what a background send could
 * not deliver, and what the morning's own repeating invoices and bills made.
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
      const outcome = await syncQuickBooks(organizationId, { budgetMs: left });
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

// ---------------------------------------------------------------- summary ---

export type KindSummary = {
  sent: number;
  waiting: number;
  failing: { id: string; name: string; href: string; error: string }[];
};

/** For the settings page: per kind, how many are there, waiting, or failing. */
export async function syncSummary(connection: QuickBooksConnection, zone: string) {
  const sentCount = (entityType: EntityType) =>
    prisma.accountingLink.count({
      where: {
        organizationId: connection.organizationId,
        provider: QUICKBOOKS,
        realmId: connection.realmId,
        entityType,
        syncedAt: { not: null },
        remoteStatus: "ACTIVE",
      },
    });

  const summarize = async <T extends { id: string }>(
    pending: Pending<T>[],
    entityType: EntityType,
  ): Promise<KindSummary> => {
    // A record QuickBooks refused is counted with the failures, not twice.
    const failing = pending
      .filter(({ link }) => link?.lastError)
      .map(({ record, link, name, href }) => ({ id: record.id, name, href, error: link!.lastError! }));
    return { sent: await sentCount(entityType), waiting: pending.length - failing.length, failing };
  };

  // Expenses that would go but for an account not yet chosen, by category.
  const withoutAccount = new Map<string, number>();
  for (const expense of await expenseRows(connection)) {
    if (dayOf(expense.spentAt, zone) < connection.sendFrom) continue;
    if (expense.reimbursable && !expense.reimbursedAt) continue;
    if (connection.paidFromAccountId && connection.expenseAccounts[expense.category]) continue;
    withoutAccount.set(expense.category, (withoutAccount.get(expense.category) ?? 0) + 1);
  }

  return {
    customers: await summarize(await pendingCustomers(connection), "CLIENT"),
    invoices: await summarize(await pendingInvoices(connection, zone), "INVOICE"),
    payments: await summarize(await pendingPayments(connection, zone), "PAYMENT"),
    expenses: await summarize(await pendingExpenses(connection, zone), "EXPENSE"),
    expensesWithoutAccount: withoutAccount,
  };
}

/** Customers alone — the first phase's summary, kept for its tests. */
export async function customerSyncSummary(connection: QuickBooksConnection) {
  const summary = await syncSummary(connection, "UTC");
  return summary.customers;
}

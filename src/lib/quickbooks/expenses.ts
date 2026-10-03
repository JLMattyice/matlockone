import "server-only";

import { QuickBooksError, queryValue, quickbooksQuery } from "./api";
import type { QuickBooksConnection } from "./connection";
import { quickbooksName } from "./customers";
import { dayOf, dollars, type RemoteOutcome } from "./invoices";
import { linkFor, saveLink, type Link } from "./links";
import { createRemote, isGone, retireRemote, updateRemote } from "./records";
import { lowerSquash } from "../import-columns";

/**
 * An expense here as a QuickBooks Online expense (a Purchase).
 *
 * Which account each category lands in is the owner's choice, made on the
 * settings page from the company's own chart of accounts, along with the
 * bank or card account expenses are paid from. Until both are chosen for a
 * category, its expenses wait. The supplier goes over as a QuickBooks vendor,
 * found by name before one is made.
 */

export type QuickBooksAccount = {
  id: string;
  name: string;
  type: string;
};

type QboAccount = { Id: string; Name: string; AccountType: string; FullyQualifiedName?: string };

/** The accounts the settings page offers: where expenses go, and what pays them. */
export async function accountChoices(connection: QuickBooksConnection) {
  const accounts = await quickbooksQuery<QboAccount>(connection, "Account", "Active = true MAXRESULTS 1000");
  const shape = (a: QboAccount): QuickBooksAccount => ({
    id: a.Id,
    name: a.FullyQualifiedName ?? a.Name,
    type: a.AccountType,
  });
  const byName = (a: QuickBooksAccount, b: QuickBooksAccount) => a.name.localeCompare(b.name);

  return {
    expense: accounts
      .filter((a) => ["Expense", "Other Expense", "Cost of Goods Sold"].includes(a.AccountType))
      .map(shape)
      .sort(byName),
    paidFrom: accounts
      .filter((a) => ["Bank", "Credit Card"].includes(a.AccountType))
      .map(shape)
      .sort(byName),
  };
}

export type ExpenseForQuickBooks = {
  id: string;
  description: string;
  category: string;
  vendor: string | null;
  amountCents: number;
  method: string;
  reference: string | null;
  spentAt: Date;
};

type QboVendor = { Id: string };

/**
 * The supplier as a QuickBooks vendor. Null when the name belongs to a
 * customer or employee there — QuickBooks keeps one list of names — in which
 * case the expense goes without a vendor and names it in its memo instead.
 */
async function vendorFor(connection: QuickBooksConnection, name: string): Promise<string | null> {
  const key = `name:${lowerSquash(name)}`;
  const link = await linkFor(connection, "VENDOR", key);
  if (link?.externalId) return link.externalId;

  const displayName = quickbooksName(name);
  const remember = async (id: string, origin: "CREATED" | "MATCHED") => {
    const now = new Date();
    await saveLink(connection, "VENDOR", key, { externalId: id, origin, syncedAt: now, lastTriedAt: now, lastError: null });
    return id;
  };

  const [existing] = await quickbooksQuery<QboVendor>(
    connection,
    "Vendor",
    `Active IN (true, false) AND DisplayName = ${queryValue(displayName)}`,
  );
  if (existing) return remember(existing.Id, "MATCHED");

  try {
    const created = await createRemote(connection, "vendor", { DisplayName: displayName });
    return remember(created.Id, "CREATED");
  } catch (error) {
    if (error instanceof QuickBooksError && error.code === "6240") return null;
    throw error;
  }
}

export async function pushExpense(
  connection: QuickBooksConnection,
  expense: ExpenseForQuickBooks,
  link: Link | null,
  zone: string,
): Promise<RemoteOutcome> {
  const accountId = connection.expenseAccounts[expense.category];
  if (!accountId || !connection.paidFromAccountId) {
    throw new QuickBooksError("Choose QuickBooks accounts for expenses on the QuickBooks settings page.", 400);
  }

  const vendorId = expense.vendor ? await vendorFor(connection, expense.vendor) : null;
  const memo = [expense.description, expense.vendor && !vendorId ? `Supplier: ${expense.vendor}` : null]
    .filter(Boolean)
    .join(" · ");

  const body = {
    // A card account takes card purchases only; a bank account cash or cheques.
    PaymentType: connection.paidFromIsCard ? "CreditCard" : expense.method === "CHECK" ? "Check" : "Cash",
    AccountRef: { value: connection.paidFromAccountId },
    TxnDate: dayOf(expense.spentAt, zone),
    ...(expense.reference ? { DocNumber: expense.reference.slice(0, 21) } : {}),
    ...(vendorId ? { EntityRef: { value: vendorId, type: "Vendor" } } : {}),
    PrivateNote: memo.slice(0, 4000),
    Line: [
      {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: dollars(expense.amountCents),
        Description: expense.description.slice(0, 4000),
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId } },
      },
    ],
  };

  const live = link?.externalId && link.remoteStatus === "ACTIVE" ? link : null;
  if (live) {
    try {
      const updated = await updateRemote(connection, "purchase", live.externalId!, live.syncToken, body);
      return { externalId: updated.Id, syncToken: updated.SyncToken, remoteStatus: "ACTIVE" };
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  const created = await createRemote(connection, "purchase", body);
  return { externalId: created.Id, syncToken: created.SyncToken, remoteStatus: "ACTIVE" };
}

/** An expense deleted here, or no longer paid out: deleted there. */
export async function deleteRemovedExpense(connection: QuickBooksConnection, link: Link) {
  if (!link.externalId || link.remoteStatus !== "ACTIVE") return;
  await retireRemote(connection, "purchase", "delete", link.externalId, link.syncToken);
}

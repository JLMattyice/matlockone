import "server-only";

import { QuickBooksError, queryValue, quickbooksQuery, quickbooksRequest } from "./api";
import { setIncomeAccount, type QuickBooksConnection } from "./connection";
import { quickbooksName } from "./customers";
import { linkFor, saveLink } from "./links";
import { lowerSquash } from "../import-columns";

/**
 * The products and services invoice lines are filed under in QuickBooks.
 *
 * QuickBooks will not take an invoice line without one. A line here copies
 * its wording from the price book but does not point back at it, so a line
 * whose name matches a price book entry goes under that entry's QuickBooks
 * twin, and any other line under one general item for its kind — Services,
 * Materials, Labor, Other charges. Two more carry the sales tax and any
 * discount as their own lines, which is what keeps every QuickBooks total
 * equal to what the customer was billed.
 *
 * Items are found by name before one is made, so a company that already has
 * a "Services" item gets its lines filed there.
 */

type QboAccount = { Id: string; Name: string; AccountType?: string };
type QboItem = { Id: string; Name: string };

export type FallbackItem =
  | "SERVICE"
  | "MATERIAL"
  | "LABOR"
  | "OTHER"
  | "SALES_TAX"
  | "DISCOUNT"
  | "PRIOR_BILLING";

const FALLBACK_ITEMS: Record<FallbackItem, { name: string; type: "Service" | "NonInventory" }> = {
  SERVICE: { name: "Services", type: "Service" },
  MATERIAL: { name: "Materials", type: "NonInventory" },
  LABOR: { name: "Labor", type: "Service" },
  OTHER: { name: "Other charges", type: "Service" },
  SALES_TAX: { name: "Sales tax", type: "Service" },
  DISCOUNT: { name: "Discount", type: "Service" },
  // A final invoice's deposit and progress invoices, taken off.
  PRIOR_BILLING: { name: "Previously billed", type: "Service" },
};

export function fallbackFor(kind: string): FallbackItem {
  return kind === "MATERIAL" || kind === "LABOR" || kind === "OTHER" ? kind : "SERVICE";
}

/**
 * The income account new items are filed under: one called Services, else
 * one with Sales in its name, else the first. Remembered once found; the
 * accountant can move any item to another account in QuickBooks.
 */
export async function incomeAccount(connection: QuickBooksConnection): Promise<string> {
  if (connection.incomeAccountId) return connection.incomeAccountId;

  const accounts = await quickbooksQuery<QboAccount>(
    connection,
    "Account",
    "AccountType = 'Income' AND Active = true",
  );
  const pick =
    accounts.find((a) => /service/i.test(a.Name)) ??
    accounts.find((a) => /sales/i.test(a.Name)) ??
    accounts[0];
  if (!pick) {
    throw new QuickBooksError(
      "QuickBooks has no income account to file sales under. Add one in QuickBooks, then send again.",
      400,
    );
  }

  await setIncomeAccount(connection.organizationId, pick.Id);
  connection.incomeAccountId = pick.Id;
  return pick.Id;
}

async function ensureItem(
  connection: QuickBooksConnection,
  entityType: "ITEM" | "ITEM_KIND",
  entityId: string,
  name: string,
  type: "Service" | "NonInventory",
): Promise<string> {
  const link = await linkFor(connection, entityType, entityId);
  if (link?.externalId) return link.externalId;

  const safeName = quickbooksName(name).slice(0, 100);
  const find = async () =>
    (
      await quickbooksQuery<QboItem>(
        connection,
        "Item",
        `Active IN (true, false) AND Name = ${queryValue(safeName)}`,
      )
    )[0];

  const remember = async (item: QboItem, origin: "CREATED" | "MATCHED") => {
    const now = new Date();
    await saveLink(connection, entityType, entityId, {
      externalId: item.Id,
      origin,
      syncedAt: now,
      lastTriedAt: now,
      lastError: null,
    });
    return item.Id;
  };

  const existing = await find();
  if (existing) return remember(existing, "MATCHED");

  try {
    const { Item } = await quickbooksRequest<{ Item: QboItem }>(connection, "POST", "item", {
      Name: safeName,
      Type: type,
      IncomeAccountRef: { value: await incomeAccount(connection) },
    });
    return remember(Item, "CREATED");
  } catch (error) {
    // Made by someone else in the moment between looking and making.
    if (error instanceof QuickBooksError && error.code === "6240") {
      const raced = await find();
      if (raced) return remember(raced, "MATCHED");
    }
    throw error;
  }
}

/** One of the general items: a line kind, sales tax, or discount. */
export function fallbackItem(connection: QuickBooksConnection, which: FallbackItem) {
  const { name, type } = FALLBACK_ITEMS[which];
  return ensureItem(connection, "ITEM_KIND", which, name, type);
}

export type PriceBookEntry = { id: string; name: string; kind: string };

/** The price book by name, the way a line's name is matched against it. */
export function priceBookByName(entries: PriceBookEntry[]) {
  return new Map(entries.map((entry) => [lowerSquash(entry.name), entry]));
}

/** The QuickBooks item a line goes under. */
export function itemForLine(
  connection: QuickBooksConnection,
  line: { name: string; kind: string },
  book: Map<string, PriceBookEntry>,
): Promise<string> {
  const entry = book.get(lowerSquash(line.name));
  if (entry) {
    return ensureItem(
      connection,
      "ITEM",
      entry.id,
      entry.name,
      entry.kind === "MATERIAL" ? "NonInventory" : "Service",
    );
  }
  return fallbackItem(connection, fallbackFor(line.kind));
}

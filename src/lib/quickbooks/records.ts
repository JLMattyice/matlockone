import "server-only";

import { QuickBooksError, quickbooksRequest } from "./api";
import type { QuickBooksConnection } from "./connection";

/**
 * Making, changing and retiring records in QuickBooks, the same way for
 * every kind.
 *
 * Every change sends back the record's SyncToken, QuickBooks' edit counter.
 * When somebody has edited the record in QuickBooks since it was last read,
 * the token is stale (error 5010): the record is read again and the change
 * tried once more, because what was decided here is meant to win.
 */

const KEYS = {
  customer: "Customer",
  invoice: "Invoice",
  payment: "Payment",
  purchase: "Purchase",
  vendor: "Vendor",
  item: "Item",
} as const;

export type Resource = keyof typeof KEYS;
export type Remote = { Id: string; SyncToken: string };

/** The record was merged away or deleted over there: find or make it again. */
export function isGone(error: unknown) {
  return error instanceof QuickBooksError && (error.code === "610" || error.status === 404);
}

function isStale(error: unknown) {
  return error instanceof QuickBooksError && error.code === "5010";
}

async function answer(
  connection: QuickBooksConnection,
  resource: Resource,
  path: string,
  body?: unknown,
): Promise<Remote> {
  const json = await quickbooksRequest<Record<string, Remote>>(
    connection,
    body === undefined ? "GET" : "POST",
    path,
    body,
  );
  return json[KEYS[resource]];
}

export function readRemote(connection: QuickBooksConnection, resource: Resource, id: string) {
  return answer(connection, resource, `${resource}/${encodeURIComponent(id)}`);
}

export function createRemote(connection: QuickBooksConnection, resource: Resource, body: object) {
  return answer(connection, resource, resource, body);
}

/** A sparse update: only the fields sent change (a Line list is replaced whole). */
export async function updateRemote(
  connection: QuickBooksConnection,
  resource: Resource,
  id: string,
  syncToken: string | null,
  fields: object,
): Promise<Remote> {
  const send = (token: string) =>
    answer(connection, resource, resource, { ...fields, Id: id, SyncToken: token, sparse: true });
  const fresh = async () => (await readRemote(connection, resource, id)).SyncToken;

  try {
    return await send(syncToken ?? (await fresh()));
  } catch (error) {
    if (isStale(error)) return send(await fresh());
    throw error;
  }
}

/**
 * Voids an invoice or deletes a payment or expense. Null when it is already
 * gone over there, which is the outcome wanted anyway.
 */
export async function retireRemote(
  connection: QuickBooksConnection,
  resource: Resource,
  operation: "void" | "delete",
  id: string,
  syncToken: string | null,
): Promise<Remote | null> {
  const send = (token: string) =>
    answer(connection, resource, `${resource}?operation=${operation}`, { Id: id, SyncToken: token });

  try {
    return await send(syncToken ?? (await readRemote(connection, resource, id)).SyncToken);
  } catch (error) {
    if (isGone(error)) return null;
    if (isStale(error)) {
      try {
        return await send((await readRemote(connection, resource, id)).SyncToken);
      } catch (again) {
        if (isGone(again)) return null;
        throw again;
      }
    }
    throw error;
  }
}

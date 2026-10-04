import "server-only";

import { markNeedsReconnect, storeTokens, type QuickBooksConnection } from "./connection";
import { QuickBooksAuthError, refreshTokens } from "./oauth";
import { QUICKBOOKS_MINOR_VERSION, quickbooksSettings } from "./settings";
import { intuitTid, logQuickBooksFailure } from "./trace";

/**
 * Talking to the QuickBooks Online accounting API for one connected company.
 *
 * Tokens are renewed here, before they run out and once more if QuickBooks
 * says one has, and stored the moment they change. Every refusal comes back
 * as a QuickBooksError carrying Intuit's error code, because the callers act
 * on a few of them: a name already taken, an edit made over there since,
 * a record that no longer exists.
 */

export class QuickBooksError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Intuit's code: "6240" a name taken, "5010" a stale edit, "610" not found. */
    readonly code: string | null = null,
    /** The owner has to connect again before anything else will work. */
    readonly reconnect = false,
    /** Intuit's reference for the request (its intuit_tid header), for its support. */
    readonly tid: string | null = null,
  ) {
    super(message);
    this.name = "QuickBooksError";
  }
}

/** Renew an access token this close to running out rather than risk it mid-request. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function renew(connection: QuickBooksConnection) {
  const settings = quickbooksSettings();
  if (!settings) {
    throw new QuickBooksError("QuickBooks is not set up on this deployment.", 0);
  }
  try {
    connection.tokens = await refreshTokens(settings, connection.tokens);
    await storeTokens(connection.organizationId, connection.tokens);
  } catch (error) {
    if (error instanceof QuickBooksAuthError) {
      if (error.reconnect) {
        await markNeedsReconnect(connection.organizationId, error.message);
        connection.needsReconnect = true;
      }
      throw new QuickBooksError(error.message, 401, null, error.reconnect, error.tid);
    }
    throw error;
  }
}

type Fault = {
  Fault?: { Error?: { Message?: string; Detail?: string; code?: string }[] };
};

function faultOf(json: unknown, status: number, tid: string | null): QuickBooksError {
  const first = (json as Fault | null)?.Fault?.Error?.[0];
  const message = [first?.Message, first?.Detail].filter(Boolean).join(": ");
  return new QuickBooksError(
    message || `QuickBooks answered ${status}.`,
    status,
    first?.code ?? null,
    false,
    tid,
  );
}

/**
 * One request to the company's API. `path` is everything after
 * /v3/company/{realmId}/, query string included.
 */
export async function quickbooksRequest<T>(
  connection: QuickBooksConnection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const settings = quickbooksSettings();
  if (!settings) throw new QuickBooksError("QuickBooks is not set up on this deployment.", 0);
  if (connection.needsReconnect) {
    throw new QuickBooksError("QuickBooks needs connecting again.", 401, null, true);
  }

  if (connection.tokens.accessExpiresAt - Date.now() < REFRESH_MARGIN_MS) {
    await renew(connection);
  }

  const separator = path.includes("?") ? "&" : "?";
  const url = `${settings.apiBase}/v3/company/${encodeURIComponent(connection.realmId)}/${path}${separator}minorversion=${QUICKBOOKS_MINOR_VERSION}`;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${connection.tokens.accessToken}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new QuickBooksError("QuickBooks could not be reached. It will be tried again.", 0);
    }

    // An access token can be refused before its stated expiry — revoked, or
    // the clock off. One renewal and one more try, then give up.
    if (response.status === 401 && attempt === 0) {
      await renew(connection);
      continue;
    }

    const json = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const fault = faultOf(json, response.status, intuitTid(response));
      logQuickBooksFailure({
        operation: `${method} ${path.split("?")[0]}`,
        organizationId: connection.organizationId,
        status: fault.status,
        code: fault.code,
        message: fault.message,
        tid: fault.tid,
      });
      throw fault;
    }
    return json as T;
  }
}

/** A value inside a QuickBooks query: quoted, with quotes and backslashes escaped. */
export function queryValue(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** `select * from {entity} where {where}`, answered as a list. */
export async function quickbooksQuery<T>(
  connection: QuickBooksConnection,
  entity: string,
  where: string,
): Promise<T[]> {
  const query = encodeURIComponent(`select * from ${entity} where ${where}`);
  const json = await quickbooksRequest<{ QueryResponse?: Record<string, unknown> }>(
    connection,
    "GET",
    `query?query=${query}`,
  );
  const list = json.QueryResponse?.[entity];
  return Array.isArray(list) ? (list as T[]) : [];
}

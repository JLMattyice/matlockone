import http from "node:http";

/**
 * A stand-in for Intuit's OAuth endpoints and the QuickBooks Online
 * accounting API, shaped from their documented requests and responses.
 *
 * Like the PayPal stand-in, it is exercised over real HTTP so a wrong header,
 * path or field fails a test. It holds the rules the sync has to live with:
 * one name per person across customers, suppliers and employees; one name
 * per item; a SyncToken that must match on every change; invoice lines whose
 * amount must equal quantity times price; payments that must point at an
 * invoice with enough left on it; expenses paid by card only from a card
 * account; access tokens that expire and refresh tokens that rotate. It
 * cannot prove Intuit's API matches this reading of their docs — the sandbox
 * company does that.
 */

export type FakeRecord = Record<string, unknown> & { Id: string; SyncToken: string };
export type FakeCustomer = FakeRecord & { DisplayName: string; Active: boolean };

type Resource = "customer" | "vendor" | "item" | "invoice" | "payment" | "purchase" | "account";

const ENTITY: Record<Resource, string> = {
  customer: "Customer",
  vendor: "Vendor",
  item: "Item",
  invoice: "Invoice",
  payment: "Payment",
  purchase: "Purchase",
  account: "Account",
};

export type FakeQuickBooks = {
  /** For QUICKBOOKS_OAUTH_BASE and QUICKBOOKS_API_BASE alike. */
  baseUrl: string;
  realmId: string;
  clientId: string;
  clientSecret: string;
  requests: { method: string; path: string; auth: string | undefined; body: unknown }[];
  customers: Map<string, FakeCustomer>;
  vendors: Map<string, FakeRecord>;
  items: Map<string, FakeRecord>;
  invoices: Map<string, FakeRecord>;
  payments: Map<string, FakeRecord>;
  purchases: Map<string, FakeRecord>;
  accounts: Map<string, FakeRecord>;
  /** Names held by employees, which customers and suppliers cannot share. */
  otherNames: Set<string>;
  /** Refresh tokens handed back on disconnect. */
  revoked: string[];
  /** A one-time code the consent screen would have issued. */
  issueCode: () => string;
  /** Every access token stops working, as an hour passing would. */
  expireAccessToken: () => void;
  /** The owner disconnects from inside QuickBooks: every token dies. */
  revokeRefreshToken: () => void;
  /** Someone edits a record inside QuickBooks, moving its SyncToken on. */
  editInQuickBooks: (id: string, fields: Record<string, unknown>, resource?: Resource) => void;
  /** A customer merged into another, so its id no longer resolves. */
  remove: (id: string) => void;
  /** A customer added in QuickBooks directly. */
  addCustomer: (fields: Record<string, unknown> & { DisplayName: string }) => FakeCustomer;
  /** An item added in QuickBooks directly. */
  addItem: (fields: Record<string, unknown> & { Name: string }) => FakeRecord;
  tokenGrants: () => number;
  close: () => Promise<void>;
};

function fault(code: string, message: string, detail = "") {
  return { Fault: { Error: [{ Message: message, Detail: detail, code }], type: "ValidationFault" } };
}

/** The value of `{field} = '…'` in a query, with \' and \\ undone. */
function valueIn(query: string, field: string): string | null {
  const match = new RegExp(`\\b${field}\\s*=\\s*'((?:\\\\.|[^'\\\\])*)'`, "i").exec(query);
  return match ? match[1].replace(/\\(.)/g, "$1") : null;
}

const cents = (amount: unknown) => Math.round(Number(amount) * 100);

export async function startFakeQuickBooks(
  options: { companyName?: string; realmId?: string; country?: string } = {},
): Promise<FakeQuickBooks> {
  const clientId = "qb-test-client";
  const clientSecret = "qb-test-secret";
  const realmId = options.realmId ?? "9130350000000001";
  const companyName = options.companyName ?? "Sandbox Company_US_1";

  const requests: FakeQuickBooks["requests"] = [];
  const store: Record<Resource, Map<string, FakeRecord>> = {
    customer: new Map(),
    vendor: new Map(),
    item: new Map(),
    invoice: new Map(),
    payment: new Map(),
    purchase: new Map(),
    account: new Map(),
  };
  const otherNames = new Set<string>();
  const revoked: string[] = [];
  const codes = new Set<string>();

  // Several businesses may connect the one fake company, each with its own
  // chain of tokens, so the good ones are sets rather than single values.
  const validAccess = new Set<string>();
  const validRefresh = new Set<string>();
  let grants = 0;
  let nextId = 100;
  let nextToken = 1;

  const newId = () => String(nextId++);

  // A chart of accounts like a new US sandbox company's, trimmed.
  for (const [Id, Name, AccountType] of [
    ["1", "Services", "Income"],
    ["2", "Sales of Product Income", "Income"],
    ["3", "Fuel", "Expense"],
    ["4", "Job Supplies", "Expense"],
    ["5", "Cost of Goods Sold", "Cost of Goods Sold"],
    ["6", "Checking", "Bank"],
    ["7", "Visa", "Credit Card"],
  ]) {
    store.account.set(Id, { Id, SyncToken: "0", Name, AccountType, Active: true });
  }

  /** Customers, suppliers and employees share one list of names. */
  const personNameTaken = (name: string, exceptId?: string) => {
    const lower = name.toLowerCase();
    if ([...otherNames].some((other) => other.toLowerCase() === lower)) return true;
    return [...store.customer.values(), ...store.vendor.values()].some(
      (r) => r.Id !== exceptId && String(r.DisplayName).toLowerCase() === lower,
    );
  };
  const itemNameTaken = (name: string, exceptId?: string) =>
    [...store.item.values()].some((r) => r.Id !== exceptId && String(r.Name).toLowerCase() === name.toLowerCase());

  const issueTokens = () => {
    grants++;
    const access = `access-${nextToken}`;
    const refresh = `refresh-${nextToken}`;
    nextToken++;
    validAccess.add(access);
    validRefresh.add(refresh);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "bearer",
      expires_in: 3600,
      x_refresh_token_expires_in: 8_726_400,
    };
  };

  /** What a create or update would break, or null when QuickBooks would take it. */
  function invalid(resource: Resource, body: Record<string, unknown>, exceptId?: string): unknown {
    if (resource === "customer" || resource === "vendor") {
      const name = String(body.DisplayName ?? "");
      if (!exceptId && !name) return fault("6000", "Business Validation Error", "DisplayName required");
      if (/:/.test(name)) return fault("6000", "Business Validation Error", "Name cannot contain a colon");
      if (name && personNameTaken(name, exceptId)) {
        return fault("6240", "Duplicate Name Exists Error", `The name supplied already exists. : ${name}`);
      }
    }
    if (resource === "item") {
      const name = String(body.Name ?? "");
      if (!name || /:/.test(name)) return fault("6000", "Business Validation Error", "Item name");
      if (itemNameTaken(name, exceptId)) return fault("6240", "Duplicate Name Exists Error", name);
      const income = (body.IncomeAccountRef as { value?: string } | undefined)?.value;
      if (!income || store.account.get(income)?.AccountType !== "Income") {
        return fault("2020", "Required param missing", "IncomeAccountRef");
      }
    }
    if (resource === "invoice") {
      const customer = (body.CustomerRef as { value?: string } | undefined)?.value;
      if (!customer || !store.customer.has(customer)) return fault("2500", "Invalid Reference Id", "CustomerRef");
      for (const line of (body.Line as Record<string, unknown>[]) ?? []) {
        const detail = line.SalesItemLineDetail as Record<string, unknown> | undefined;
        const item = (detail?.ItemRef as { value?: string } | undefined)?.value;
        if (!item || !store.item.has(item)) return fault("2500", "Invalid Reference Id", "ItemRef");
        if (detail?.Qty !== undefined && cents(Number(detail.Qty) * Number(detail.UnitPrice)) !== cents(line.Amount)) {
          return fault("6070", "Amount is not equal to UnitPrice * Qty");
        }
      }
    }
    if (resource === "payment") {
      type PaymentLine = { Amount: number; LinkedTxn: { TxnId: string }[] };
      const lines = (body.Line as PaymentLine[]) ?? [];
      // An update applies the payment afresh: what it already paid on an
      // invoice is that invoice's to take again.
      const before = (exceptId ? (store.payment.get(exceptId)?.Line as PaymentLine[]) : null) ?? [];
      for (const line of lines) {
        const invoice = store.invoice.get(line.LinkedTxn?.[0]?.TxnId ?? "");
        if (!invoice) return fault("2500", "Invalid Reference Id", "LinkedTxn");
        const already = before
          .filter((l) => l.LinkedTxn?.[0]?.TxnId === invoice.Id)
          .reduce((sum, l) => sum + cents(l.Amount), 0);
        if (cents(line.Amount) > cents(invoice.Balance) + already) {
          return fault("6000", "Payment is more than the balance");
        }
      }
    }
    if (resource === "purchase") {
      const from = store.account.get((body.AccountRef as { value?: string } | undefined)?.value ?? "");
      if (!from || !["Bank", "Credit Card"].includes(String(from.AccountType))) {
        return fault("2500", "Invalid Reference Id", "AccountRef");
      }
      if ((body.PaymentType === "CreditCard") !== (from.AccountType === "Credit Card")) {
        return fault("6000", "Business Validation Error", "PaymentType does not match the account");
      }
      for (const line of (body.Line as Record<string, unknown>[]) ?? []) {
        const detail = line.AccountBasedExpenseLineDetail as Record<string, unknown> | undefined;
        const account = (detail?.AccountRef as { value?: string } | undefined)?.value;
        if (!account || !store.account.has(account)) return fault("2500", "Invalid Reference Id", "AccountRef");
      }
      const vendor = (body.EntityRef as { value?: string } | undefined)?.value;
      if (vendor && !store.vendor.has(vendor)) return fault("2500", "Invalid Reference Id", "EntityRef");
    }
    return null;
  }

  /** What QuickBooks works out for itself after a change. */
  function settle(resource: Resource, record: FakeRecord) {
    if (resource === "invoice") {
      const total = ((record.Line as { Amount: number }[]) ?? []).reduce((sum, l) => sum + cents(l.Amount), 0);
      const paid = [...store.payment.values()]
        .flatMap((p) => p.Line as { Amount: number; LinkedTxn: { TxnId: string }[] }[])
        .filter((l) => l.LinkedTxn?.[0]?.TxnId === record.Id)
        .reduce((sum, l) => sum + cents(l.Amount), 0);
      record.TotalAmt = total / 100;
      record.Balance = (total - paid) / 100;
    }
  }

  function settleInvoicesOf(payment: FakeRecord) {
    for (const line of (payment.Line as { LinkedTxn: { TxnId: string }[] }[]) ?? []) {
      const invoice = store.invoice.get(line.LinkedTxn?.[0]?.TxnId ?? "");
      if (invoice) settle("invoice", invoice);
    }
  }

  // Intuit tags every response with a reference for its support desk.
  let tids = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const method = req.method ?? "GET";
      const auth = req.headers.authorization;
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json", intuit_tid: `fake-tid-${++tids}` });
        res.end(JSON.stringify(body));
      };

      const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

      // ------------------------------------------------------------ tokens ---
      if (url.pathname === "/oauth2/v1/tokens/bearer") {
        const form = new URLSearchParams(raw);
        requests.push({ method, path: url.pathname, auth, body: Object.fromEntries(form) });
        if (auth !== basic) return send(401, { error: "invalid_client" });

        if (form.get("grant_type") === "authorization_code") {
          const code = form.get("code") ?? "";
          if (!codes.delete(code)) return send(400, { error: "invalid_grant" });
          if (!form.get("redirect_uri")) return send(400, { error: "invalid_request" });
          return send(200, issueTokens());
        }
        if (form.get("grant_type") === "refresh_token") {
          const presented = form.get("refresh_token") ?? "";
          if (!validRefresh.delete(presented)) return send(400, { error: "invalid_grant" });
          return send(200, issueTokens());
        }
        return send(400, { error: "unsupported_grant_type" });
      }

      if (url.pathname === "/v2/oauth2/tokens/revoke") {
        const body = JSON.parse(raw || "{}") as { token?: string };
        requests.push({ method, path: url.pathname, auth, body });
        if (auth !== basic) return send(401, { error: "invalid_client" });
        if (body.token) {
          revoked.push(body.token);
          validRefresh.delete(body.token);
        }
        return send(200, {});
      }

      // --------------------------------------------------------------- api ---
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      requests.push({ method, path: `${url.pathname}${url.search}`, auth, body });

      const prefix = `/v3/company/${realmId}/`;
      if (!url.pathname.startsWith(prefix)) return send(404, fault("610", "Object Not Found"));
      if (!url.searchParams.get("minorversion")) return send(400, fault("4000", "minorversion missing"));
      if (!auth?.startsWith("Bearer ") || !validAccess.has(auth.slice("Bearer ".length))) {
        return send(401, {
          Fault: { Error: [{ Message: "message=AuthenticationFailed", code: "3200" }], type: "AUTHENTICATION" },
        });
      }

      const rest = url.pathname.slice(prefix.length);

      if (method === "GET" && rest === `companyinfo/${realmId}`) {
        return send(200, { CompanyInfo: { CompanyName: companyName, Country: options.country ?? "US", Id: "1" } });
      }

      if (method === "GET" && rest === "query") {
        const query = url.searchParams.get("query") ?? "";
        const entity = /from\s+(\w+)/i.exec(query)?.[1]?.toLowerCase() as Resource | undefined;
        if (!entity || !(entity in store)) return send(200, { QueryResponse: {} });
        const displayName = valueIn(query, "DisplayName");
        const name = valueIn(query, "Name");
        const type = valueIn(query, "AccountType");
        const found = [...store[entity].values()].filter(
          (r) =>
            (displayName === null || String(r.DisplayName).toLowerCase() === displayName.toLowerCase()) &&
            (name === null || String(r.Name).toLowerCase() === name.toLowerCase()) &&
            (type === null || r.AccountType === type),
        );
        return send(200, { QueryResponse: found.length ? { [ENTITY[entity]]: found } : {} });
      }

      const [resource, id] = rest.split("/") as [Resource, string | undefined];
      if (!(resource in store)) return send(400, fault("4000", `No fake for ${method} ${rest}`));
      const records = store[resource];

      if (method === "GET" && id) {
        const record = records.get(decodeURIComponent(id));
        if (!record) return send(400, fault("610", "Object Not Found"));
        return send(200, { [ENTITY[resource]]: record });
      }

      if (method === "POST" && !id && body) {
        const operation = url.searchParams.get("operation");

        if (typeof body.Id === "string") {
          const existing = records.get(body.Id);
          if (!existing) return send(400, fault("610", "Object Not Found"));
          if (body.SyncToken !== existing.SyncToken) {
            return send(400, fault("5010", "Stale Object Error", "You and someone else edited the same thing"));
          }

          if (operation === "delete") {
            records.delete(existing.Id);
            if (resource === "payment") settleInvoicesOf(existing);
            return send(200, { [ENTITY[resource]]: { Id: existing.Id, status: "Deleted" } });
          }
          if (operation === "void") {
            const paid = [...store.payment.values()].some((p) =>
              (p.Line as { LinkedTxn: { TxnId: string }[] }[]).some((l) => l.LinkedTxn?.[0]?.TxnId === existing.Id),
            );
            if (paid) return send(400, fault("6000", "Business Validation Error", "Invoice has payments applied"));
            const voided = { ...existing, Line: [], TotalAmt: 0, Balance: 0, PrivateNote: "Voided", SyncToken: String(Number(existing.SyncToken) + 1) };
            records.set(existing.Id, voided);
            return send(200, { [ENTITY[resource]]: voided });
          }

          const problem = invalid(resource, body, existing.Id);
          if (problem) return send(400, problem);
          const { sparse: _sparse, ...fields } = body;
          const updated: FakeRecord = { ...existing, ...fields, Id: existing.Id, SyncToken: String(Number(existing.SyncToken) + 1) };
          settle(resource, updated);
          records.set(existing.Id, updated);
          if (resource === "payment") settleInvoicesOf(updated);
          return send(200, { [ENTITY[resource]]: updated });
        }

        const problem = invalid(resource, body);
        if (problem) return send(400, problem);
        const created: FakeRecord = { Active: true, ...body, Id: newId(), SyncToken: "0" };
        settle(resource, created);
        records.set(created.Id, created);
        if (resource === "payment") settleInvoicesOf(created);
        return send(200, { [ENTITY[resource]]: created });
      }

      return send(400, fault("4000", `No fake for ${method} ${rest}`));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake QuickBooks did not start");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    realmId,
    clientId,
    clientSecret,
    requests,
    customers: store.customer as Map<string, FakeCustomer>,
    vendors: store.vendor,
    items: store.item,
    invoices: store.invoice,
    payments: store.payment,
    purchases: store.purchase,
    accounts: store.account,
    otherNames,
    revoked,
    issueCode() {
      const code = `code-${codes.size + 1}-${Date.now()}`;
      codes.add(code);
      return code;
    },
    expireAccessToken() {
      validAccess.clear();
    },
    revokeRefreshToken() {
      validRefresh.clear();
      validAccess.clear();
    },
    editInQuickBooks(id, fields, resource = "customer") {
      const record = store[resource].get(id);
      if (!record) throw new Error(`No fake ${resource} ${id}`);
      store[resource].set(id, { ...record, ...fields, SyncToken: String(Number(record.SyncToken) + 1) });
    },
    remove(id) {
      store.customer.delete(id);
    },
    addCustomer(fields) {
      const created = { Active: true, ...fields, Id: newId(), SyncToken: "0" } as FakeCustomer;
      store.customer.set(created.Id, created);
      return created;
    },
    addItem(fields) {
      const created: FakeRecord = { Active: true, Type: "Service", ...fields, Id: newId(), SyncToken: "0" };
      store.item.set(created.Id, created);
      return created;
    },
    tokenGrants: () => grants,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

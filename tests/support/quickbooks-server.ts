import http from "node:http";

/**
 * A stand-in for Intuit's OAuth endpoints and the QuickBooks Online
 * accounting API, shaped from their documented requests and responses.
 *
 * Like the PayPal stand-in, it is exercised over real HTTP so a wrong header,
 * path or field fails a test. It holds the rules the sync has to live with:
 * one name per person across customers, suppliers and employees; a SyncToken
 * that must match on every update; access tokens that expire; refresh tokens
 * that rotate and can be revoked. It cannot prove Intuit's API matches this
 * reading of their docs — the sandbox company does that.
 */

export type FakeCustomer = Record<string, unknown> & {
  Id: string;
  SyncToken: string;
  DisplayName: string;
  Active: boolean;
};

export type FakeQuickBooks = {
  /** For QUICKBOOKS_OAUTH_BASE and QUICKBOOKS_API_BASE alike. */
  baseUrl: string;
  realmId: string;
  clientId: string;
  clientSecret: string;
  requests: { method: string; path: string; auth: string | undefined; body: unknown }[];
  customers: Map<string, FakeCustomer>;
  /** Names held by suppliers and employees, which customers cannot share. */
  otherNames: Set<string>;
  /** Refresh tokens handed back on disconnect. */
  revoked: string[];
  /** A one-time code the consent screen would have issued. */
  issueCode: () => string;
  /** Every access token stops working, as an hour passing would. */
  expireAccessToken: () => void;
  /** The owner disconnects from inside QuickBooks: every token dies. */
  revokeRefreshToken: () => void;
  /** Someone edits a customer inside QuickBooks, moving its SyncToken on. */
  editInQuickBooks: (id: string, fields: Record<string, unknown>) => void;
  /** A customer merged into another, so its id no longer resolves. */
  remove: (id: string) => void;
  /** A customer added in QuickBooks directly. */
  addCustomer: (fields: Record<string, unknown> & { DisplayName: string }) => FakeCustomer;
  tokenGrants: () => number;
  close: () => Promise<void>;
};

function fault(code: string, message: string, detail = "") {
  return { Fault: { Error: [{ Message: message, Detail: detail, code }], type: "ValidationFault" } };
}

/** The value of `DisplayName = '…'` in a query, with \' and \\ undone. */
function displayNameIn(query: string): string | null {
  const match = /DisplayName\s*=\s*'((?:\\.|[^'\\])*)'/i.exec(query);
  return match ? match[1].replace(/\\(.)/g, "$1") : null;
}

export async function startFakeQuickBooks(
  options: { companyName?: string; realmId?: string } = {},
): Promise<FakeQuickBooks> {
  const clientId = "qb-test-client";
  const clientSecret = "qb-test-secret";
  const realmId = options.realmId ?? "9130350000000001";
  const companyName = options.companyName ?? "Sandbox Company_US_1";

  const requests: FakeQuickBooks["requests"] = [];
  const customers = new Map<string, FakeCustomer>();
  const otherNames = new Set<string>();
  const revoked: string[] = [];
  const codes = new Set<string>();

  // Several businesses may connect the one fake company, each with its own
  // chain of tokens, so the good ones are sets rather than single values.
  const validAccess = new Set<string>();
  const validRefresh = new Set<string>();
  let grants = 0;
  let nextId = 1;
  let nextToken = 1;

  const nameTaken = (name: string, exceptId?: string) => {
    const lower = name.toLowerCase();
    if ([...otherNames].some((other) => other.toLowerCase() === lower)) return true;
    return [...customers.values()].some(
      (c) => c.Id !== exceptId && c.DisplayName.toLowerCase() === lower,
    );
  };

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

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const method = req.method ?? "GET";
      const auth = req.headers.authorization;
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
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
        return send(200, { CompanyInfo: { CompanyName: companyName, Id: "1" } });
      }

      if (method === "GET" && rest === "query") {
        const query = url.searchParams.get("query") ?? "";
        if (!/from Customer/i.test(query)) return send(200, { QueryResponse: {} });
        const name = displayNameIn(query);
        const found = [...customers.values()].filter(
          (c) => name === null || c.DisplayName.toLowerCase() === name.toLowerCase(),
        );
        return send(200, { QueryResponse: found.length ? { Customer: found } : {} });
      }

      if (method === "GET" && rest.startsWith("customer/")) {
        const customer = customers.get(decodeURIComponent(rest.slice("customer/".length)));
        if (!customer) return send(400, fault("610", "Object Not Found"));
        return send(200, { Customer: customer });
      }

      if (method === "POST" && rest === "customer" && body) {
        const name = typeof body.DisplayName === "string" ? body.DisplayName : "";
        if (/:/.test(name)) return send(400, fault("6000", "Business Validation Error", "Name cannot contain a colon"));

        if (typeof body.Id === "string") {
          const existing = customers.get(body.Id);
          if (!existing) return send(400, fault("610", "Object Not Found"));
          if (body.SyncToken !== existing.SyncToken) {
            return send(400, fault("5010", "Stale Object Error", "You and someone else edited the same thing"));
          }
          if (name && nameTaken(name, existing.Id)) {
            return send(400, fault("6240", "Duplicate Name Exists Error", `The name supplied already exists. : ${name}`));
          }
          const { sparse: _sparse, ...fields } = body;
          const updated: FakeCustomer = {
            ...existing,
            ...fields,
            Id: existing.Id,
            SyncToken: String(Number(existing.SyncToken) + 1),
          };
          customers.set(existing.Id, updated);
          return send(200, { Customer: updated });
        }

        if (!name) return send(400, fault("6000", "Business Validation Error", "DisplayName required"));
        if (nameTaken(name)) {
          return send(400, fault("6240", "Duplicate Name Exists Error", `The name supplied already exists. : ${name}`));
        }
        const created: FakeCustomer = { ...body, Id: String(nextId++), SyncToken: "0", DisplayName: name, Active: true };
        customers.set(created.Id, created);
        return send(200, { Customer: created });
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
    customers,
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
    editInQuickBooks(id, fields) {
      const customer = customers.get(id);
      if (!customer) throw new Error(`No fake customer ${id}`);
      customers.set(id, { ...customer, ...fields, SyncToken: String(Number(customer.SyncToken) + 1) });
    },
    remove(id) {
      customers.delete(id);
    },
    addCustomer(fields) {
      const created: FakeCustomer = { ...fields, Id: String(nextId++), SyncToken: "0", Active: true };
      customers.set(created.Id, created);
      return created;
    },
    tokenGrants: () => grants,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

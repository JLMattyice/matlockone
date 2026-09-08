import http from "node:http";

/**
 * A stand-in for PayPal's Invoicing API.
 *
 * Shaped from their documented request and response bodies, so the adapter is
 * exercised over real HTTP: the OAuth handshake, the Basic and Bearer headers,
 * the JSON shapes, the status codes. Mocking `fetch` instead would only prove
 * the mock was called, and would not catch a wrong header, a wrong path, or a
 * misread response field.
 *
 * It is not PayPal. It cannot prove their real API matches this reading of
 * their docs — only a sandbox account does that. What it does prove is that
 * given these responses, the adapter behaves correctly.
 */

export type FakePaypalOptions = {
  clientId?: string;
  clientSecret?: string;
  /** Force a failure mode instead of the happy path. */
  failWith?: {
    status: number;
    body?: unknown;
    /** Which path to fail on. Defaults to everything after auth. */
    path?: string;
  };
  /** Omit the payer link from the send response, exercising the re-read. */
  linkOnlyOnReread?: boolean;
  /**
   * What the token response says the app may do. PayPal returns this as a
   * space-separated list, and an app without Invoicing ticked simply lacks the
   * invoicing URI. Pass [] to omit the field entirely, as an older or
   * differently-shaped response would.
   */
  scopes?: string[];
};

export type FakePaypal = {
  baseUrl: string;
  /** Every request the adapter made, for asserting on what was sent. */
  requests: {
    method: string;
    path: string;
    auth: string | undefined;
    requestId: string | undefined;
    body: unknown;
  }[];
  /** Invoices the adapter created, keyed by id. */
  invoices: Map<string, PaypalInvoiceRecord>;
  /** How many access tokens have been issued — a cache hit issues none. */
  tokenGrants: () => number;
  /** Simulates the customer paying, so a later poll finds it. */
  pay: (invoiceId: string, amount: string, paymentId: string) => void;
  close: () => Promise<void>;
};

type PaypalInvoiceRecord = {
  id: string;
  status: string;
  detail: Record<string, unknown>;
  items: unknown;
  payments: {
    transactions: {
      payment_id: string;
      amount: { value: string; currency_code: string };
      payment_date: string;
      method: string;
    }[];
  };
};

const TOKEN = "A21AAtestaccesstoken";

export async function startFakePaypal(
  options: FakePaypalOptions = {},
): Promise<FakePaypal> {
  const clientId = options.clientId ?? "test-client-id";
  const clientSecret = options.clientSecret ?? "test-client-secret";

  const scopes = options.scopes ?? [
    "https://uri.paypal.com/services/invoicing",
    "https://uri.paypal.com/services/payments/payment",
  ];

  const requests: FakePaypal["requests"] = [];
  const invoices = new Map<string, PaypalInvoiceRecord>();
  let tokenGrants = 0;
  let nextId = 1;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));

    req.on("end", () => {
      const path = req.url ?? "";
      const method = req.method ?? "GET";
      const auth = req.headers.authorization;

      const send = (status: number, body: unknown) => {
        const payload = body === null ? "" : JSON.stringify(body);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(payload);
      };

      // ------------------------------------------------------------ token ---
      if (path.startsWith("/v1/oauth2/token")) {
        requests.push({ method, path, auth, requestId: undefined, body: raw });

        const expected =
          "Basic " +
          Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

        if (auth !== expected) {
          return send(401, {
            error: "invalid_client",
            error_description: "Client Authentication failed",
          });
        }
        if (!raw.includes("grant_type=client_credentials")) {
          return send(400, { error: "unsupported_grant_type" });
        }

        tokenGrants += 1;

        return send(200, {
          access_token: TOKEN,
          token_type: "Bearer",
          expires_in: 32400,
          ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
        });
      }

      const body = raw ? JSON.parse(raw) : null;
      requests.push({
        method,
        path,
        auth,
        requestId: req.headers["paypal-request-id"] as string | undefined,
        body,
      });

      // Every other endpoint needs the bearer token.
      if (auth !== `Bearer ${TOKEN}`) {
        return send(401, { name: "AUTHENTICATION_FAILURE" });
      }

      const failure = options.failWith;
      if (failure && (!failure.path || path.startsWith(failure.path))) {
        return send(failure.status, failure.body ?? { name: "SERVER_ERROR" });
      }

      // ------------------------------------------------------ list (probe) ---
      if (method === "GET" && path.startsWith("/v2/invoicing/invoices?")) {
        return send(200, { total_items: 0, items: [] });
      }

      // ----------------------------------------------------------- create ---
      if (method === "POST" && path === "/v2/invoicing/invoices") {
        const requestId = req.headers["paypal-request-id"] as string | undefined;

        // PayPal returns the original invoice for a repeated request id rather
        // than creating a second one.
        if (requestId) {
          for (const invoice of invoices.values()) {
            if (invoice.detail.__requestId === requestId) {
              return send(200, { id: invoice.id, status: invoice.status });
            }
          }
        }

        const id = `INV2-TEST-${nextId++}`;
        invoices.set(id, {
          id,
          status: "DRAFT",
          detail: { ...(body?.detail ?? {}), __requestId: requestId },
          items: body?.items,
          payments: { transactions: [] },
        });

        // Exactly what PayPal answers: a link to the new invoice, with no
        // id field anywhere in it. The fake used to return { id }, which is
        // how a create that always failed against the live API passed here.
        return send(201, {
          rel: "self",
          href: `https://api-m.paypal.com/v2/invoicing/invoices/${id}`,
          method: "GET",
        });
      }

      // ------------------------------------------------------------- send ---
      const sendMatch = /^\/v2\/invoicing\/invoices\/([^/]+)\/send$/.exec(path);
      if (method === "POST" && sendMatch) {
        const invoice = invoices.get(sendMatch[1]);
        if (!invoice) return send(404, { name: "RESOURCE_NOT_FOUND" });

        invoice.status = "SENT";

        if (options.linkOnlyOnReread) {
          // Some responses come back without the payer link.
          return send(200, { id: invoice.id, status: "SENT" });
        }

        return send(200, {
          id: invoice.id,
          status: "SENT",
          links: [
            { rel: "self", href: `https://api-m.paypal.com/v2/invoicing/invoices/${invoice.id}` },
            { rel: "payer-view", href: `https://www.paypal.com/invoice/p/#${invoice.id}` },
          ],
        });
      }

      // -------------------------------------------------------------- get ---
      const getMatch = /^\/v2\/invoicing\/invoices\/([^/?]+)$/.exec(path);
      if (method === "GET" && getMatch) {
        const invoice = invoices.get(getMatch[1]);
        if (!invoice) return send(404, { name: "RESOURCE_NOT_FOUND" });

        return send(200, {
          id: invoice.id,
          status: invoice.status,
          detail: {
            ...invoice.detail,
            metadata: {
              recipient_view_url: `https://www.paypal.com/invoice/p/#${invoice.id}`,
            },
          },
          items: invoice.items,
          payments: invoice.payments,
        });
      }

      return send(404, { name: "RESOURCE_NOT_FOUND", message: path });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Fake PayPal did not bind to a port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    invoices,
    tokenGrants: () => tokenGrants,
    pay(invoiceId, amount, paymentId) {
      const invoice = invoices.get(invoiceId);
      if (!invoice) throw new Error(`No fake invoice ${invoiceId}`);

      invoice.payments.transactions.push({
        payment_id: paymentId,
        amount: { value: amount, currency_code: "USD" },
        payment_date: "2026-08-30",
        method: "PAYPAL",
      });
      invoice.status = "PAID";
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

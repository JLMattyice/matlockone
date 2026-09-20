import http from "node:http";

/**
 * A stand-in for Stripe's Invoicing API.
 *
 * Shaped from their documented requests and responses, so the adapter is
 * exercised over real HTTP: the Bearer header, the form encoding, the bracket
 * syntax for nested keys, the idempotency header, the status codes. Mocking
 * `fetch` would only prove the mock was called — it would not catch a JSON body
 * sent to an API that reads form data, which is the mistake this shape invites.
 *
 * It is not Stripe. It cannot prove their live API matches this reading of
 * their docs; only a test-mode key against the real thing does that. What it
 * proves is that given these responses, the adapter behaves correctly.
 */

export type FakeStripeOptions = {
  secretKey?: string;
  /** Force a failure instead of the happy path. */
  failWith?: {
    status: number;
    body?: unknown;
    /** Which path to fail on. Defaults to every path. */
    path?: string;
  };
  /** Answer /v1/account with 403, as a restricted key does. */
  noAccountAccess?: boolean;
  /** Return a finalized invoice with no hosted page. */
  withoutHostedUrl?: boolean;
  /** An existing customer with this email, so the adapter reuses it. */
  existingCustomer?: { id: string; email: string };
};

export type FakeStripe = {
  baseUrl: string;
  /** Every request the adapter made, for asserting on what was sent. */
  requests: {
    method: string;
    path: string;
    auth: string | undefined;
    idempotencyKey: string | undefined;
    contentType: string | undefined;
    /** Form fields, parsed the way Stripe would read them. */
    form: Record<string, string>;
  }[];
  invoices: Map<string, StripeInvoiceRecord>;
  customers: Map<string, { id: string; name?: string; email?: string }>;
  /** Simulates the customer paying, so a later poll finds it. */
  pay: (invoiceId: string, amountCents: number, intentId: string) => void;
  close: () => Promise<void>;
};

type StripeInvoiceRecord = {
  id: string;
  status: string;
  currency: string;
  customer: string;
  amount_paid: number;
  hosted_invoice_url: string | null;
  payment_intent: string | null;
  status_transitions: { paid_at: number | null };
  metadata: Record<string, string>;
};

function send(
  response: http.ServerResponse,
  status: number,
  body: unknown,
) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function stripeError(message: string, code = "invalid_request_error") {
  return { error: { message, type: code } };
}

export async function startFakeStripe(
  options: FakeStripeOptions = {},
): Promise<FakeStripe> {
  const secretKey = options.secretKey ?? "sk_test_fake";
  const requests: FakeStripe["requests"] = [];
  const invoices = new Map<string, StripeInvoiceRecord>();
  const customers = new Map<
    string,
    { id: string; name?: string; email?: string }
  >();

  if (options.existingCustomer) {
    customers.set(options.existingCustomer.id, options.existingCustomer);
  }

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${++counter}`;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const form = Object.fromEntries(new URLSearchParams(raw));
      const path = request.url ?? "";
      const auth = request.headers.authorization;

      requests.push({
        method: request.method ?? "GET",
        path,
        auth,
        idempotencyKey: request.headers["idempotency-key"] as string | undefined,
        contentType: request.headers["content-type"] as string | undefined,
        form,
      });

      if (auth !== `Bearer ${secretKey}`) {
        return send(
          response,
          401,
          stripeError("Invalid API Key provided", "authentication_error"),
        );
      }

      const failure = options.failWith;
      if (failure && (!failure.path || path.startsWith(failure.path))) {
        return send(
          response,
          failure.status,
          failure.body ?? stripeError("Something went wrong"),
        );
      }

      // --------------------------------------------------------- account ---
      if (path.startsWith("/v1/account")) {
        if (options.noAccountAccess) {
          return send(
            response,
            403,
            stripeError("The provided key does not have the required permissions"),
          );
        }
        return send(response, 200, {
          id: "acct_fake",
          email: "billing@northside.test",
          business_profile: { name: "Northside Home Services" },
          settings: { dashboard: { display_name: "Northside Home Services" } },
        });
      }

      // -------------------------------------------------------- customers ---
      if (path.startsWith("/v1/customers")) {
        if (request.method === "GET") {
          const email = new URL(path, "http://x").searchParams.get("email");
          const match = [...customers.values()].find(
            (customer) => customer.email === email,
          );
          return send(response, 200, { data: match ? [match] : [] });
        }

        const customer = {
          id: nextId("cus"),
          name: form.name,
          email: form.email,
        };
        customers.set(customer.id, customer);
        return send(response, 200, customer);
      }

      // ------------------------------------------------------ invoiceitems ---
      if (path.startsWith("/v1/invoiceitems")) {
        const invoice = invoices.get(form.invoice ?? "");
        if (!invoice) {
          return send(response, 404, stripeError("No such invoice"));
        }
        return send(response, 200, { id: nextId("ii") });
      }

      // ---------------------------------------------------------- invoices ---
      if (path.startsWith("/v1/invoices")) {
        // Finalize: /v1/invoices/{id}/finalize_invoice
        const finalize = /^\/v1\/invoices\/([^/?]+)\/finalize_invoice/.exec(path);
        if (finalize) {
          const invoice = invoices.get(finalize[1]);
          if (!invoice) {
            return send(response, 404, stripeError("No such invoice"));
          }
          invoice.status = "open";
          invoice.hosted_invoice_url = options.withoutHostedUrl
            ? null
            : `https://invoice.stripe.test/i/${invoice.id}`;
          return send(response, 200, invoice);
        }

        // Retrieve: /v1/invoices/{id}
        const retrieve = /^\/v1\/invoices\/([^/?]+)$/.exec(path);
        if (retrieve && request.method === "GET") {
          const invoice = invoices.get(retrieve[1]);
          if (!invoice) {
            return send(response, 404, stripeError("No such invoice"));
          }
          return send(response, 200, invoice);
        }

        // List, used by verify as its probe.
        if (request.method === "GET") {
          return send(response, 200, { data: [...invoices.values()] });
        }

        // Create.
        const invoice: StripeInvoiceRecord = {
          id: nextId("in"),
          status: "draft",
          currency: form.currency ?? "usd",
          customer: form.customer ?? "",
          amount_paid: 0,
          hosted_invoice_url: null,
          payment_intent: null,
          status_transitions: { paid_at: null },
          metadata: form["metadata[matlock_invoice]"]
            ? { matlock_invoice: form["metadata[matlock_invoice]"] }
            : {},
        };
        invoices.set(invoice.id, invoice);
        return send(response, 200, invoice);
      }

      send(response, 404, stripeError(`Unrecognized request URL: ${path}`));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    invoices,
    customers,
    pay(invoiceId, amountCents, intentId) {
      const invoice = invoices.get(invoiceId);
      if (!invoice) throw new Error(`no such fake invoice: ${invoiceId}`);

      invoice.status = "paid";
      invoice.amount_paid = amountCents;
      invoice.payment_intent = intentId;
      invoice.status_transitions.paid_at = Math.floor(Date.now() / 1000);
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

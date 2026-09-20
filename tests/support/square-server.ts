import http from "node:http";

/**
 * A stand-in for Square's Invoices, Orders and Customers APIs.
 *
 * Shaped from their documented requests and responses, so the adapter is
 * exercised over real HTTP: the Bearer header, the Square-Version header, the
 * body-carried idempotency keys, the three-object assembly, the status codes.
 *
 * It is not Square. It cannot prove their live API matches this reading of
 * their docs — only a sandbox account does that. What it proves is that given
 * these responses, the adapter behaves correctly.
 */

export type FakeSquareOptions = {
  accessToken?: string;
  /** Locations the account has. Defaults to one. */
  locations?: { id: string; name: string }[];
  /** Force a failure instead of the happy path. */
  failWith?: {
    status: number;
    body?: unknown;
    /** Which path to fail on. Defaults to every path. */
    path?: string;
  };
  /** Publish returns an invoice with no public page. */
  withoutPublicUrl?: boolean;
  /** A customer already on the account with this email. */
  existingCustomer?: { id: string; email: string };
  /** Answer a retrieved invoice with no order_id, an unexpected shape. */
  invoiceWithoutOrder?: boolean;
};

export type FakeSquare = {
  baseUrl: string;
  requests: {
    method: string;
    path: string;
    auth: string | undefined;
    version: string | undefined;
    body: Record<string, unknown>;
  }[];
  invoices: Map<string, SquareInvoiceRecord>;
  orders: Map<string, SquareOrderRecord>;
  /** Simulates the customer paying, so a later poll finds it. */
  pay: (invoiceId: string, amountCents: number, tenderId: string) => void;
  close: () => Promise<void>;
};

type SquareOrderRecord = {
  id: string;
  location_id: string;
  customer_id: string;
  reference_id?: string;
  tenders: { id: string; amount_money: { amount: number }; created_at: string }[];
};

type SquareInvoiceRecord = {
  id: string;
  version: number;
  status: string;
  order_id: string;
  public_url: string | null;
  delivery_method?: string;
};

function send(response: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function squareError(detail: string, code = "BAD_REQUEST", category = "INVALID_REQUEST_ERROR") {
  return { errors: [{ category, code, detail }] };
}

export async function startFakeSquare(
  options: FakeSquareOptions = {},
): Promise<FakeSquare> {
  const accessToken = options.accessToken ?? "sq0atp-fake";
  const locations = options.locations ?? [
    { id: "L7KQW1ABC", name: "Northside Yard" },
  ];

  const requests: FakeSquare["requests"] = [];
  const invoices = new Map<string, SquareInvoiceRecord>();
  const orders = new Map<string, SquareOrderRecord>();
  const customers = new Map<string, { id: string; email_address?: string }>();

  if (options.existingCustomer) {
    customers.set(options.existingCustomer.id, {
      id: options.existingCustomer.id,
      email_address: options.existingCustomer.email,
    });
  }

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${++counter}`;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        return send(response, 400, squareError("Body was not JSON"));
      }

      const path = request.url ?? "";
      const auth = request.headers.authorization;

      requests.push({
        method: request.method ?? "GET",
        path,
        auth,
        version: request.headers["square-version"] as string | undefined,
        body,
      });

      if (auth !== `Bearer ${accessToken}`) {
        return send(
          response,
          401,
          squareError("This request could not be authorized.", "UNAUTHORIZED", "AUTHENTICATION_ERROR"),
        );
      }

      const failure = options.failWith;
      if (failure && (!failure.path || path.startsWith(failure.path))) {
        return send(
          response,
          failure.status,
          failure.body ?? squareError("Something went wrong"),
        );
      }

      // -------------------------------------------------------- locations ---
      if (path.startsWith("/v2/locations")) {
        return send(response, 200, {
          locations: locations.map((location) => ({
            ...location,
            status: "ACTIVE",
          })),
        });
      }

      // -------------------------------------------------------- customers ---
      if (path.startsWith("/v2/customers/search")) {
        const query = body.query as
          | { filter?: { email_address?: { exact?: string } } }
          | undefined;
        const email = query?.filter?.email_address?.exact;
        const match = [...customers.values()].find(
          (customer) => customer.email_address === email,
        );
        return send(response, 200, match ? { customers: [match] } : {});
      }

      if (path.startsWith("/v2/customers")) {
        const customer = {
          id: nextId("CUST"),
          email_address: body.email_address as string | undefined,
        };
        customers.set(customer.id, customer);
        return send(response, 200, { customer });
      }

      // ----------------------------------------------------------- orders ---
      const retrieveOrder = /^\/v2\/orders\/([^/?]+)$/.exec(path);
      if (retrieveOrder && request.method === "GET") {
        const order = orders.get(retrieveOrder[1]);
        if (!order) return send(response, 404, squareError("Order not found", "NOT_FOUND"));
        return send(response, 200, { order });
      }

      if (path.startsWith("/v2/orders")) {
        const input = body.order as {
          location_id?: string;
          customer_id?: string;
          reference_id?: string;
        };
        const order: SquareOrderRecord = {
          id: nextId("ORDER"),
          location_id: input?.location_id ?? "",
          customer_id: input?.customer_id ?? "",
          reference_id: input?.reference_id,
          tenders: [],
        };
        orders.set(order.id, order);
        return send(response, 200, { order });
      }

      // --------------------------------------------------------- invoices ---
      const publish = /^\/v2\/invoices\/([^/?]+)\/publish$/.exec(path);
      if (publish) {
        const invoice = invoices.get(publish[1]);
        if (!invoice) return send(response, 404, squareError("Invoice not found", "NOT_FOUND"));

        // Square rejects a publish carrying a stale version.
        if (body.version !== invoice.version) {
          return send(
            response,
            409,
            squareError("Invoice version is out of date", "VERSION_MISMATCH"),
          );
        }

        invoice.status = "UNPAID";
        invoice.version += 1;
        invoice.public_url = options.withoutPublicUrl
          ? null
          : `https://squareup.test/pay/${invoice.id}`;
        return send(response, 200, { invoice });
      }

      const retrieveInvoice = /^\/v2\/invoices\/([^/?]+)$/.exec(path);
      if (retrieveInvoice && request.method === "GET") {
        const invoice = invoices.get(retrieveInvoice[1]);
        if (!invoice) return send(response, 404, squareError("Invoice not found", "NOT_FOUND"));

        return send(response, 200, {
          invoice: options.invoiceWithoutOrder
            ? { ...invoice, order_id: undefined }
            : invoice,
        });
      }

      if (path.startsWith("/v2/invoices")) {
        const input = body.invoice as {
          order_id?: string;
          delivery_method?: string;
        };
        const invoice: SquareInvoiceRecord = {
          id: nextId("INV"),
          version: 0,
          status: "DRAFT",
          order_id: input?.order_id ?? "",
          public_url: null,
          delivery_method: input?.delivery_method,
        };
        invoices.set(invoice.id, invoice);
        return send(response, 200, { invoice });
      }

      send(response, 404, squareError(`Unknown path ${path}`, "NOT_FOUND"));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    invoices,
    orders,
    pay(invoiceId, amountCents, tenderId) {
      const invoice = invoices.get(invoiceId);
      if (!invoice) throw new Error(`no such fake invoice: ${invoiceId}`);

      const order = orders.get(invoice.order_id);
      if (!order) throw new Error(`no such fake order: ${invoice.order_id}`);

      invoice.status = "PAID";
      order.tenders.push({
        id: tenderId,
        amount_money: { amount: amountCents },
        created_at: new Date().toISOString(),
      });
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

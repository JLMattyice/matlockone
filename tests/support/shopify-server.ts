import http from "node:http";

/**
 * A stand-in for Shopify's GraphQL Admin API.
 *
 * Shaped from their documented mutation and object, so the adapter is
 * exercised over real HTTP: the access-token header, the single GraphQL
 * endpoint, and — the part that matters most here — a 200 response carrying an
 * `errors` array, which is how Shopify reports a failure and how anything
 * checking only the status code misses it.
 *
 * It is not Shopify. Only a development store proves their API matches this.
 */

export type FakeShopifyOptions = {
  accessToken?: string;
  shopName?: string;
  /** Respond with this HTTP status instead of the happy path. */
  failWith?: { status: number; body?: unknown };
  /** Answer 200 with a GraphQL errors array, as Shopify does for most faults. */
  graphqlError?: { message: string; code?: string };
  /** Return userErrors from draftOrderCreate, as a rejected input does. */
  userError?: string;
  /** Create the draft but return no invoiceUrl. */
  withoutInvoiceUrl?: boolean;
};

export type FakeShopify = {
  baseUrl: string;
  requests: {
    path: string;
    token: string | undefined;
    query: string;
    variables: Record<string, unknown>;
  }[];
  drafts: Map<string, DraftRecord>;
  /** Simulates the customer completing the Shopify checkout. */
  pay: (draftId: string, orderId: string) => void;
  close: () => Promise<void>;
};

type DraftRecord = {
  id: string;
  status: string;
  invoiceUrl: string | null;
  totalAmount: string;
  completedAt: string | null;
  orderId: string | null;
};

function send(response: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

export async function startFakeShopify(
  options: FakeShopifyOptions = {},
): Promise<FakeShopify> {
  const accessToken = options.accessToken ?? "shpat_fake";
  const shopName = options.shopName ?? "Northside Supply";

  const requests: FakeShopify["requests"] = [];
  const drafts = new Map<string, DraftRecord>();

  let counter = 0;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let payload: { query?: string; variables?: Record<string, unknown> } = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        return send(response, 400, { errors: [{ message: "Body was not JSON" }] });
      }

      const token = request.headers["x-shopify-access-token"] as string | undefined;

      requests.push({
        path: request.url ?? "",
        token,
        query: payload.query ?? "",
        variables: payload.variables ?? {},
      });

      if (token !== accessToken) {
        return send(response, 401, {
          errors: [{ message: "Invalid API key or access token" }],
        });
      }

      if (options.failWith) {
        return send(response, options.failWith.status, options.failWith.body ?? {});
      }

      // Shopify reports most faults as 200 with an errors array.
      if (options.graphqlError) {
        return send(response, 200, {
          errors: [
            {
              message: options.graphqlError.message,
              ...(options.graphqlError.code
                ? { extensions: { code: options.graphqlError.code } }
                : {}),
            },
          ],
        });
      }

      const query = payload.query ?? "";

      // ------------------------------------------------------------ shop ---
      if (query.includes("shop {")) {
        return send(response, 200, {
          data: {
            shop: { name: shopName, myshopifyDomain: "northside-supply.myshopify.com" },
            draftOrders: { nodes: [] },
          },
        });
      }

      // ---------------------------------------------------------- create ---
      if (query.includes("draftOrderCreate")) {
        if (options.userError) {
          return send(response, 200, {
            data: {
              draftOrderCreate: {
                draftOrder: null,
                userErrors: [{ field: ["input"], message: options.userError }],
              },
            },
          });
        }

        const input = (payload.variables?.input ?? {}) as {
          lineItems?: { originalUnitPrice?: string }[];
        };
        const id = `gid://shopify/DraftOrder/${++counter}`;

        const draft: DraftRecord = {
          id,
          status: "OPEN",
          invoiceUrl: options.withoutInvoiceUrl
            ? null
            : `https://northside-supply.myshopify.com/invoices/${counter}`,
          totalAmount: input.lineItems?.[0]?.originalUnitPrice ?? "0.00",
          completedAt: null,
          orderId: null,
        };
        drafts.set(id, draft);

        return send(response, 200, {
          data: {
            draftOrderCreate: {
              draftOrder: {
                id: draft.id,
                invoiceUrl: draft.invoiceUrl,
                status: draft.status,
              },
              userErrors: [],
            },
          },
        });
      }

      // ------------------------------------------------------------ read ---
      if (query.includes("draftOrder(")) {
        const id = String(payload.variables?.id ?? "");
        const draft = drafts.get(id);

        if (!draft) return send(response, 200, { data: { draftOrder: null } });

        return send(response, 200, {
          data: {
            draftOrder: {
              id: draft.id,
              status: draft.status,
              completedAt: draft.completedAt,
              totalPriceSet: { shopMoney: { amount: draft.totalAmount } },
              order: draft.orderId ? { id: draft.orderId } : null,
            },
          },
        });
      }

      send(response, 200, { errors: [{ message: "Unknown operation" }] });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    drafts,
    pay(draftId, orderId) {
      const draft = drafts.get(draftId);
      if (!draft) throw new Error(`no such fake draft order: ${draftId}`);

      draft.status = "COMPLETED";
      draft.orderId = orderId;
      draft.completedAt = new Date().toISOString();
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

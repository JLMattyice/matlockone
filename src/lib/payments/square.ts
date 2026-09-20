import "server-only";

import type {
  PaymentAdapter,
  PaymentConfig,
  PaymentCredentials,
  PaymentRequest,
  ProviderResult,
  RemotePayment,
} from "./providers";

/**
 * Square, through their Invoices API.
 *
 * Invoices rather than Payment Links, for the reason the other two adapters
 * avoid checkout flows: the link has to still work in week three, and it has
 * to name what it is for. A published Square invoice has a public page that
 * stays up, needs no return URL — which a desktop install could not provide —
 * and records what settled against it.
 *
 * Square is the fiddliest of the three because an invoice is assembled from
 * three objects rather than one: a customer, an order carrying the line, and
 * the invoice that points at both. Publishing is a separate call again, and
 * only that produces the payable page.
 *
 * Matlock One stays the system of record, and Square never emails anything:
 * the delivery method is SHARE_MANUALLY, because two invoices arriving from
 * two senders for the same money is how a client pays twice.
 */

const PRODUCTION = "https://connect.squareup.com";
const SANDBOX = "https://connect.squareupsandbox.com";

const TIMEOUT_MS = 20_000;

/** Days the published invoice stays payable before Square calls it overdue. */
const DAYS_UNTIL_DUE = 30;

/**
 * The API version this adapter was written against.
 *
 * Square dates its versions and keeps each one working for about a year, so
 * pinning is what stops a response shape changing under a deployed desktop
 * install that nobody is going to update. Bump it deliberately, after reading
 * their changelog — never to whatever is newest.
 *
 * A version Square does not recognise is refused on the first call, and
 * describeApi below names that case specifically, because the message Square
 * returns for it does not obviously point at this constant.
 */
const SQUARE_VERSION = "2025-01-23";

/**
 * Where to send requests.
 *
 * The env override exists so the test suite can point this at a local fake.
 * Deliberately operator-level rather than saved config: config is editable
 * from the settings screen, and a redirectable API base would be a way to walk
 * off with an access token.
 */
function apiBase(config: PaymentConfig) {
  const override = process.env.SQUARE_API_BASE;
  if (override) return override.replace(/\/$/, "");
  return config.environment === "sandbox" ? SANDBOX : PRODUCTION;
}

/** Square's own idempotency keys, which go in the body rather than a header. */
function idempotencyKey(parts: (string | number)[]) {
  // Square caps these at 45 characters.
  return `matlock-${parts.join("-")}`.slice(0, 45);
}

/** An ISO date, which is what Square's due_date wants — not a timestamp. */
function dueDate(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------- http ---

type SquareError = {
  errors?: { category?: string; code?: string; detail?: string; field?: string }[];
};

async function call<T>(
  config: PaymentConfig,
  credentials: PaymentCredentials,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ProviderResult<T>> {
  const accessToken = credentials.accessToken?.trim();
  if (!accessToken) {
    return { ok: false, error: "A Square access token is required." };
  }

  let response: Response;

  try {
    response = await fetch(`${apiBase(config)}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Square-Version": SQUARE_VERSION,
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: describeNetwork(error) };
  }

  const text = await response.text();
  let body: unknown = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    if (!response.ok) {
      return { ok: false, error: `Square returned ${response.status}.` };
    }
  }

  if (!response.ok) {
    return { ok: false, error: describeApi(response.status, body as SquareError) };
  }

  return { ok: true, value: body as T };
}

/** Turns Square's developer-facing errors into something actionable. */
function describeApi(status: number, body: SquareError | null) {
  const first = body?.errors?.[0];
  const detail = first?.detail;
  const code = first?.code ?? "";

  // Square refuses an unrecognised Square-Version with a generic-sounding
  // message that never mentions a header, so it is named here rather than
  // leaving somebody to wonder which field they filled in wrongly.
  if (/version/i.test(code) || /Square-Version|API version/i.test(detail ?? "")) {
    return `Square rejected the API version this build pins (${SQUARE_VERSION}). It has most likely aged out — the constant is SQUARE_VERSION in src/lib/payments/square.ts. Square said: ${detail ?? code}`;
  }

  if (status === 401) {
    return "Square rejected that access token. Check it was copied whole, and that it belongs to the same environment selected above — a sandbox token will not work against production.";
  }
  if (status === 403 || code === "INSUFFICIENT_SCOPES") {
    return `That Square token is missing permissions. It needs CUSTOMERS_WRITE, ORDERS_WRITE, INVOICES_WRITE and PAYMENTS_READ.${detail ? ` Square said: ${detail}` : ""}`;
  }
  if (code === "NOT_FOUND" || status === 404) {
    return "Square no longer has that invoice. Remove the pay link and add a new one.";
  }
  if (status === 429) {
    return "Square is rate limiting requests. Wait a moment and try again.";
  }
  if (status >= 500) {
    return "Square is having trouble at their end. Try again shortly.";
  }

  return detail ?? code ?? `Square returned ${status}.`;
}

function describeNetwork(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);

  if (/timeout|abort/i.test(raw)) {
    return "Square did not respond in time. Check the connection and try again.";
  }
  if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(raw)) {
    return "Could not reach Square. Check the connection and try again.";
  }
  return raw.slice(0, 300);
}

// --------------------------------------------------------------- responses ---

type SquareLocation = { id?: string; name?: string; status?: string };
type SquareCustomer = { id?: string };
type SquareOrder = {
  id?: string;
  tenders?: {
    id?: string;
    amount_money?: { amount?: number };
    created_at?: string;
  }[];
};
type SquareInvoice = {
  id?: string;
  version?: number;
  status?: string;
  public_url?: string | null;
  order_id?: string | null;
};

// ---------------------------------------------------------------- adapter ---

export const squareAdapter: PaymentAdapter = {
  async verify(config, credentials) {
    const locations = await call<{ locations?: SquareLocation[] }>(
      config,
      credentials,
      "/v2/locations",
    );
    if (!locations.ok) return locations;

    const all = locations.value?.locations ?? [];
    const wanted = config.locationId?.trim();

    // The location id is typed in by hand, and a wrong one would otherwise
    // surface much later as a confusing failure when an invoice is raised.
    // Checking it here, where the available ids can be listed back, turns a
    // mystery into a copy-paste.
    if (!wanted) {
      const options = all
        .map((location) => `${location.name ?? "Unnamed"} (${location.id})`)
        .join(", ");
      return {
        ok: false,
        error: options
          ? `Which Square location should the money belong to? This account has: ${options}`
          : "That Square account has no locations to bill from.",
      };
    }

    const match = all.find((location) => location.id === wanted);
    if (!match) {
      const options = all
        .map((location) => `${location.name ?? "Unnamed"} (${location.id})`)
        .join(", ");
      return {
        ok: false,
        error: options
          ? `Square has no location ${wanted} on this account. It has: ${options}`
          : `Square has no location ${wanted} on this account.`,
      };
    }

    const sandbox = config.environment === "sandbox";
    const name = match.name ?? "Square";

    return {
      ok: true,
      value: { accountLabel: sandbox ? `${name} (sandbox)` : name },
    };
  },

  async createLink(request: PaymentRequest, config, credentials) {
    const locationId = config.locationId?.trim();
    if (!locationId) {
      return {
        ok: false,
        error: "No Square location is configured. Reconnect the account under Settings → Payments.",
      };
    }

    const currency = request.currency.toUpperCase();

    // One customer per client email, reused, or the merchant's Square
    // directory fills with a duplicate per document.
    let customerId: string | null = null;

    if (request.clientEmail) {
      const found = await call<{ customers?: SquareCustomer[] }>(
        config,
        credentials,
        "/v2/customers/search",
        {
          method: "POST",
          body: {
            limit: 1,
            query: { filter: { email_address: { exact: request.clientEmail } } },
          },
        },
      );
      if (!found.ok) return found;
      customerId = found.value?.customers?.[0]?.id ?? null;
    }

    if (!customerId) {
      const created = await call<{ customer?: SquareCustomer }>(
        config,
        credentials,
        "/v2/customers",
        {
          method: "POST",
          body: {
            idempotency_key: idempotencyKey(["cust", request.invoiceNumber]),
            given_name: request.clientName,
            ...(request.clientEmail ? { email_address: request.clientEmail } : {}),
          },
        },
      );
      if (!created.ok) return created;

      customerId = created.value?.customer?.id ?? null;
      if (!customerId) {
        return {
          ok: false,
          error: "Square created the customer but did not return its id.",
        };
      }
    }

    // The order carries the money. A Square invoice has no amount of its own —
    // it points at an order, and asks for that order's balance.
    const order = await call<{ order?: SquareOrder }>(
      config,
      credentials,
      "/v2/orders",
      {
        method: "POST",
        body: {
          idempotency_key: idempotencyKey([
            "order",
            request.invoiceNumber,
            request.amountCents,
          ]),
          order: {
            location_id: locationId,
            customer_id: customerId,
            reference_id: request.invoiceNumber.slice(0, 40),
            line_items: [
              {
                name: request.description.slice(0, 500) || `Invoice ${request.invoiceNumber}`,
                quantity: "1",
                base_price_money: { amount: request.amountCents, currency },
              },
            ],
          },
        },
      },
    );
    if (!order.ok) return order;

    const orderId = order.value?.order?.id;
    if (!orderId) {
      return {
        ok: false,
        error: "Square accepted the order but did not return its id.",
      };
    }

    const invoice = await call<{ invoice?: SquareInvoice }>(
      config,
      credentials,
      "/v2/invoices",
      {
        method: "POST",
        body: {
          idempotency_key: idempotencyKey([
            "inv",
            request.invoiceNumber,
            request.amountCents,
          ]),
          invoice: {
            location_id: locationId,
            order_id: orderId,
            primary_recipient: { customer_id: customerId },
            payment_requests: [
              {
                request_type: "BALANCE",
                due_date: dueDate(DAYS_UNTIL_DUE),
                // Square must not charge a card on file by itself.
                automatic_payment_source: "NONE",
              },
            ],
            // Matlock One sends the document; Square just hosts the page.
            delivery_method: "SHARE_MANUALLY",
            accepted_payment_methods: { card: true, square_gift_card: false },
            title: `Invoice ${request.invoiceNumber}`.slice(0, 255),
            description: `${request.organizationName} — invoice ${request.invoiceNumber}`.slice(0, 65_536),
          },
        },
      },
    );
    if (!invoice.ok) return invoice;

    const draft = invoice.value?.invoice;
    if (!draft?.id) {
      return {
        ok: false,
        error: "Square accepted the invoice but did not return its id.",
      };
    }

    // A draft has no public page. Publishing is what produces one, and it
    // needs the version Square just handed back — its check against two
    // people editing the same invoice.
    const published = await call<{ invoice?: SquareInvoice }>(
      config,
      credentials,
      `/v2/invoices/${draft.id}/publish`,
      {
        method: "POST",
        body: {
          idempotency_key: idempotencyKey(["pub", request.invoiceNumber]),
          version: draft.version ?? 0,
        },
      },
    );
    if (!published.ok) return published;

    const url = published.value?.invoice?.public_url;
    if (!url) {
      return {
        ok: false,
        error:
          "Square published the invoice but returned no payment page. Check the invoice in your Square dashboard.",
      };
    }

    return { ok: true, value: { url, ref: draft.id } };
  },

  async listPayments(ref, config, credentials) {
    if (!ref) {
      return {
        ok: false,
        error: "This invoice has no Square request to check. Add a pay link first.",
      };
    }

    const invoice = await call<{ invoice?: SquareInvoice }>(
      config,
      credentials,
      `/v2/invoices/${ref}`,
    );
    if (!invoice.ok) return invoice;

    const orderId = invoice.value?.invoice?.order_id;
    // An invoice always has an order, but a shape that surprises us should
    // read as "nothing settled yet" rather than as an error on a screen the
    // business checks every day.
    if (!orderId) return { ok: true, value: [] };

    // The money is on the order, as tenders: one per time somebody paid,
    // each with its own id, which is what makes polling twice safe.
    const order = await call<{ order?: SquareOrder }>(
      config,
      credentials,
      `/v2/orders/${orderId}`,
    );
    if (!order.ok) return order;

    const payments: RemotePayment[] = [];

    for (const tender of order.value?.order?.tenders ?? []) {
      const amountCents = tender.amount_money?.amount ?? 0;
      // Without an id there is nothing to deduplicate on, and recording it
      // would mean recording it again on every future check.
      if (!tender.id || amountCents <= 0) continue;

      const paidAt = new Date(tender.created_at ?? Date.now());

      payments.push({
        externalId: tender.id,
        amountCents,
        paidAt: Number.isNaN(paidAt.getTime()) ? new Date() : paidAt,
        reference: invoice.value?.invoice?.status ?? null,
      });
    }

    return { ok: true, value: payments };
  },
};

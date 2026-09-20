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
 * Shopify, through draft orders.
 *
 * Shopify Payments is not a gateway that can be pointed at an arbitrary
 * invoice: it settles checkouts inside a Shopify store and nothing else. What
 * a store *can* do is raise a draft order with custom line items and hand back
 * an `invoiceUrl` — a checkout Shopify hosts, which the customer pays with
 * whatever that store has enabled, Shopify Payments included. That URL lasts
 * until the draft is completed or deleted, so unlike Clover it can go straight
 * onto an invoice.
 *
 * The consequence worth understanding before connecting: the money lands in
 * the store's Shopify payouts, and each invoice paid this way becomes an order
 * in the store's own admin. For a business that already runs a Shopify store
 * that is the point. For one that does not, any of the other processors is a
 * better fit, and the settings screen says so.
 *
 * Matlock One stays the system of record. The draft order carries one line —
 * the outstanding balance — named after our invoice, and Shopify is never
 * asked to email it: `draftOrderInvoiceSend` is not called, because two
 * invoices from two senders for the same money is how a client pays twice.
 */

/**
 * The Admin API version this adapter was written against.
 *
 * Shopify dates versions quarterly and supports each for a year, so pinning is
 * what stops a response shape moving under a deployment nobody is updating.
 * Bump deliberately, after reading their changelog — never to whatever is
 * newest. Taken from Shopify's own current documentation.
 */
const API_VERSION = "2026-07";

const TIMEOUT_MS = 20_000;

/**
 * Where to send requests.
 *
 * The env override exists so the test suite can point this at a local fake.
 * Deliberately operator-level rather than saved config: config is editable
 * from the settings screen, and a redirectable API base would be a way to walk
 * off with an Admin API token, which can read a store's whole order history.
 */
function endpoint(config: PaymentConfig) {
  const override = process.env.SHOPIFY_API_BASE;
  const base = override
    ? override.replace(/\/$/, "")
    : `https://${shopDomain(config)}`;

  return `${base}/admin/api/${API_VERSION}/graphql.json`;
}

/**
 * The store's admin domain, tidied.
 *
 * People paste whatever is in their address bar, which is usually the
 * storefront — `northsidesupply.com`, or the admin URL with a path on the end.
 * The Admin API answers on the myshopify.com domain only, so anything else is
 * refused with an explanation rather than a connection error.
 */
export function shopDomain(config: PaymentConfig): string {
  return (config.shopDomain ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

export function shopDomainProblem(domain: string): string | null {
  if (!domain) return "Enter your store's .myshopify.com domain.";

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    return `Shopify's Admin API only answers on a myshopify.com domain, and ${domain} is not one. It is the address in your store's admin, like northside-supply.myshopify.com — not your storefront domain.`;
  }

  return null;
}

// ------------------------------------------------------------------ money ---

/** Cents to the decimal string Shopify wants, e.g. 89735 -> "897.35". */
function toDecimal(cents: number) {
  return (cents / 100).toFixed(2);
}

/**
 * Shopify's decimal string back to cents.
 *
 * Rounded rather than truncated: 897.35 * 100 lands on 89734.999… in binary
 * floating point, and truncating would quietly lose a cent on a payment.
 */
function toCents(value: string | number | null | undefined) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

// ------------------------------------------------------------------- http ---

type GraphQLResponse<T> = {
  data?: T;
  errors?: { message?: string; extensions?: { code?: string } }[];
};

async function graphql<T>(
  config: PaymentConfig,
  credentials: PaymentCredentials,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<ProviderResult<T>> {
  const accessToken = credentials.accessToken?.trim();
  if (!accessToken) {
    return { ok: false, error: "A Shopify Admin API access token is required." };
  }

  const domain = shopDomain(config);
  const problem = shopDomainProblem(domain);
  if (problem) return { ok: false, error: problem };

  let response: Response;

  try {
    response = await fetch(endpoint(config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: describeNetwork(error) };
  }

  const text = await response.text();
  let body: GraphQLResponse<T> | null = null;

  try {
    body = text ? (JSON.parse(text) as GraphQLResponse<T>) : null;
  } catch {
    if (!response.ok) {
      return { ok: false, error: describeHttp(response.status) };
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      error: body?.errors?.[0]?.message
        ? `${describeHttp(response.status)} Shopify said: ${body.errors[0].message}`
        : describeHttp(response.status),
    };
  }

  // GraphQL answers 200 with an errors array, so a failure here looks like a
  // success to anything only checking the status code.
  if (body?.errors?.length) {
    const first = body.errors[0];

    if (first.extensions?.code === "THROTTLED") {
      return {
        ok: false,
        error: "Shopify is rate limiting requests. Wait a moment and try again.",
      };
    }
    if (/access denied|permission/i.test(first.message ?? "")) {
      return {
        ok: false,
        error: `That Shopify token is missing permissions. The app needs write_draft_orders and read_orders. Shopify said: ${first.message}`,
      };
    }

    return { ok: false, error: first.message ?? "Shopify refused that request." };
  }

  if (!body?.data) {
    return { ok: false, error: "Shopify returned no data." };
  }

  return { ok: true, value: body.data };
}

function describeHttp(status: number) {
  if (status === 401) {
    return "Shopify rejected that access token. Check it was copied whole, and that it belongs to this store.";
  }
  if (status === 402) {
    return "That Shopify store is not currently active — its plan needs attention before it can take payments.";
  }
  if (status === 403) {
    return "Shopify refused that request. The app needs write_draft_orders and read_orders on this store.";
  }
  if (status === 404) {
    return "Shopify has no store at that address. Check the myshopify.com domain.";
  }
  if (status === 423) {
    return "That Shopify store is locked.";
  }
  if (status === 429) {
    return "Shopify is rate limiting requests. Wait a moment and try again.";
  }
  if (status >= 500) {
    return "Shopify is having trouble at their end. Try again shortly.";
  }
  return `Shopify returned ${status}.`;
}

function describeNetwork(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);

  if (/timeout|abort/i.test(raw)) {
    return "Shopify did not respond in time. Check the connection and try again.";
  }
  if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(raw)) {
    return "Could not reach that Shopify store. Check the myshopify.com domain.";
  }
  return raw.slice(0, 300);
}

// -------------------------------------------------------------- documents ---

const SHOP_QUERY = `
  query {
    shop { name myshopifyDomain }
    draftOrders(first: 1) { nodes { id } }
  }
`;

const CREATE_DRAFT = `
  mutation matlockDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id invoiceUrl status }
      userErrors { field message }
    }
  }
`;

/**
 * Deliberately small.
 *
 * Every field named here is one that has to still exist in a year, on a
 * deployment nobody is updating. `order { id }` is enough to know the draft
 * was paid — completing a draft order checkout is payment in full, and the
 * order it creates is what settles it — so the amount comes from the draft's
 * own total rather than from a second set of fields on Order.
 */
const READ_DRAFT = `
  query matlockDraftOrder($id: ID!) {
    draftOrder(id: $id) {
      id
      status
      completedAt
      totalPriceSet { shopMoney { amount } }
      order { id }
    }
  }
`;

type ShopData = {
  shop?: { name?: string; myshopifyDomain?: string };
};

type CreateDraftData = {
  draftOrderCreate?: {
    draftOrder?: { id?: string; invoiceUrl?: string | null; status?: string };
    userErrors?: { field?: string[]; message?: string }[];
  };
};

type ReadDraftData = {
  draftOrder?: {
    id?: string;
    status?: string;
    completedAt?: string | null;
    totalPriceSet?: { shopMoney?: { amount?: string } };
    order?: { id?: string } | null;
  } | null;
};

// ---------------------------------------------------------------- adapter ---

export const shopifyAdapter: PaymentAdapter = {
  async verify(config, credentials) {
    const domain = shopDomain(config);
    const problem = shopDomainProblem(domain);
    if (problem) return { ok: false, error: problem };

    // One query covering both things worth proving: that the token works, and
    // that it can see draft orders — which is the API this adapter lives on.
    // A token with only read_products would otherwise connect happily and fail
    // on the first invoice.
    const result = await graphql<ShopData>(config, credentials, SHOP_QUERY);
    if (!result.ok) return result;

    const name = result.value?.shop?.name?.trim();

    return {
      ok: true,
      value: { accountLabel: name ? `${name} (Shopify)` : `Shopify — ${domain}` },
    };
  },

  async createLink(request: PaymentRequest, config, credentials) {
    const result = await graphql<CreateDraftData>(config, credentials, CREATE_DRAFT, {
      input: {
        // A custom line item, so nothing has to exist in the store's catalog.
        // The business sells work, not products Shopify knows about.
        lineItems: [
          {
            title: `${request.description} (invoice ${request.invoiceNumber})`.slice(0, 255),
            originalUnitPrice: toDecimal(request.amountCents),
            quantity: 1,
            requiresShipping: false,
            taxable: false,
          },
        ],
        ...(request.clientEmail ? { email: request.clientEmail } : {}),
        note: `${request.organizationName} — invoice ${request.invoiceNumber}`,
        tags: ["matlock-one"],
        // Shopify works out tax from the store's own settings, and this line
        // is already the taxed total from our document. Taxing it again would
        // bill the client twice for the same tax.
        taxExempt: true,
      },
    });
    if (!result.ok) return result;

    const userError = result.value?.draftOrderCreate?.userErrors?.[0];
    if (userError?.message) {
      return { ok: false, error: `Shopify refused that draft order: ${userError.message}` };
    }

    const draft = result.value?.draftOrderCreate?.draftOrder;
    const url = draft?.invoiceUrl;

    if (!draft?.id || !url) {
      return {
        ok: false,
        error:
          "Shopify created the draft order but returned no checkout link. Check Drafts in your Shopify admin before trying again.",
      };
    }

    return { ok: true, value: { url, ref: draft.id } };
  },

  async listPayments(ref, config, credentials) {
    if (!ref) {
      return {
        ok: false,
        error: "This invoice has no Shopify draft order to check. Add a pay link first.",
      };
    }

    const result = await graphql<ReadDraftData>(config, credentials, READ_DRAFT, {
      id: ref,
    });
    if (!result.ok) return result;

    const draft = result.value?.draftOrder;
    if (!draft) {
      return {
        ok: false,
        error: "Shopify no longer has that draft order. Remove the pay link and add a new one.",
      };
    }

    const orderId = draft.order?.id;
    // Still a draft: nobody has been through the checkout. Not a failure.
    if (!orderId) return { ok: true, value: [] };

    const amountCents = toCents(draft.totalPriceSet?.shopMoney?.amount);
    if (amountCents <= 0) return { ok: true, value: [] };

    const paidAt = draft.completedAt ? new Date(draft.completedAt) : new Date();

    const payments: RemotePayment[] = [
      {
        // The order's own id, which does not change however often this is
        // polled — a draft becomes exactly one order.
        externalId: orderId,
        amountCents,
        paidAt: Number.isNaN(paidAt.getTime()) ? new Date() : paidAt,
        reference: draft.status ?? null,
      },
    ];

    return { ok: true, value: payments };
  },
};

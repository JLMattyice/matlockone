import "server-only";

import type {
  PaymentAdapter,
  PaymentConfig,
  PaymentCredentials,
  PaymentRequest,
  ProviderResult,
} from "./providers";

/**
 * Clover, through their Ecommerce Hosted Checkout.
 *
 * Clover is the one processor here that cannot hand out a link which lasts.
 * A hosted checkout session expires fifteen minutes after it is created — the
 * response says so itself, in `expirationTime` — and Clover exposes no API for
 * the invoices a merchant can email from their own dashboard. A link minted
 * when the invoice is sent would be dead long before anybody opened the email.
 *
 * So the address that goes on the invoice is ours: the client-facing invoice
 * page's `/pay` route, which calls `createCheckoutSession` below when somebody
 * actually clicks and redirects them straight to Clover. The fifteen minutes
 * start at the click, which is the only moment they can be useful.
 *
 * Two things follow from that, and both are stated in the settings screen:
 *
 * Hosted deployments only. The route has to be reachable by a client at home,
 * and a desktop install serving an office network is not.
 *
 * No automatic reconciliation. Every click mints a new session, so there is no
 * single handle to poll — `reconciles: false`, and payments are recorded by
 * hand, exactly as they are for a pasted payment link. Clover's webhooks are
 * how that would eventually be fixed, and they need a public endpoint this
 * adapter deliberately does not yet have.
 */

const PRODUCTION = "https://api.clover.com";
const SANDBOX = "https://apisandbox.dev.clover.com";

const CHECKOUTS = "/invoicingcheckoutservice/v1/checkouts";

const TIMEOUT_MS = 20_000;

/**
 * Where to send requests.
 *
 * The env override exists so the test suite can point this at a local fake.
 * Deliberately operator-level rather than saved config: config is editable
 * from the settings screen, and a redirectable API base would be a way to walk
 * off with a private key.
 */
function apiBase(config: PaymentConfig) {
  const override = process.env.CLOVER_API_BASE;
  if (override) return override.replace(/\/$/, "");
  return config.environment === "sandbox" ? SANDBOX : PRODUCTION;
}

// ------------------------------------------------------------------- http ---

type CloverError = {
  message?: string;
  error?: { message?: string };
  messages?: { message?: string }[];
};

type CheckoutSession = {
  href?: string;
  checkoutSessionId?: string;
  expirationTime?: number;
};

async function createSession(
  request: {
    amountCents: number;
    name: string;
    note: string;
    clientName: string;
    clientEmail: string | null;
  },
  config: PaymentConfig,
  credentials: PaymentCredentials,
): Promise<ProviderResult<CheckoutSession>> {
  const privateKey = credentials.privateKey?.trim();
  const merchantId = config.merchantId?.trim();

  if (!privateKey) return { ok: false, error: "A Clover private key is required." };
  if (!merchantId) {
    return {
      ok: false,
      error:
        "No Clover merchant ID is configured. Reconnect the account under Settings → Payments.",
    };
  }

  // Clover splits a name into two fields and has no single one. Everything
  // after the first space is the surname, which is wrong for some names and
  // is only ever shown back to the payer on their own receipt.
  const [firstName, ...rest] = request.clientName.trim().split(/\s+/);

  let response: Response;

  try {
    response = await fetch(`${apiBase(config)}${CHECKOUTS}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "X-Clover-Merchant-Id": merchantId,
        Authorization: `Bearer ${privateKey}`,
      },
      body: JSON.stringify({
        customer: {
          ...(firstName ? { firstName } : {}),
          ...(rest.length ? { lastName: rest.join(" ") } : {}),
          ...(request.clientEmail ? { email: request.clientEmail } : {}),
        },
        shoppingCart: {
          lineItems: [
            {
              name: request.name.slice(0, 100),
              // Clover takes the price in the smallest currency unit, which is
              // what the rest of the application stores.
              price: request.amountCents,
              unitQty: 1,
              note: request.note.slice(0, 100),
            },
          ],
        },
      }),
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
      return { ok: false, error: `Clover returned ${response.status}.` };
    }
  }

  if (!response.ok) {
    return { ok: false, error: describeApi(response.status, body as CloverError) };
  }

  const session = body as CheckoutSession;
  if (!session?.href) {
    return {
      ok: false,
      error: "Clover created a checkout but returned no address to send the client to.",
    };
  }

  return { ok: true, value: session };
}

/** Turns Clover's developer-facing errors into something actionable. */
function describeApi(status: number, body: CloverError | null) {
  const said =
    body?.message ?? body?.error?.message ?? body?.messages?.[0]?.message;

  if (status === 401) {
    return "Clover rejected that private key. Check it was copied whole, and that it belongs to the same environment selected above — a sandbox key will not work against production.";
  }
  if (status === 403) {
    return `Clover refused that request. The token needs Ecommerce permissions on this merchant.${said ? ` Clover said: ${said}` : ""}`;
  }
  if (status === 406) {
    // Clover's own documented symptom for a token created under the wrong
    // integration type, and the message it returns does not say so.
    return "That Clover token is not set up for Hosted Checkout. In the Clover developer dashboard, open the app's Ecommerce API tokens and set the integration type to Hosted Checkout, then generate the key again.";
  }
  if (status === 404) {
    return "Clover does not recognise that merchant ID. Check it against the one in your Clover dashboard.";
  }
  if (status === 429) {
    return "Clover is rate limiting requests. Wait a moment and try again.";
  }
  if (status >= 500) {
    return "Clover is having trouble at their end. Try again shortly.";
  }

  return said ?? `Clover returned ${status}.`;
}

function describeNetwork(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);

  if (/timeout|abort/i.test(raw)) {
    return "Clover did not respond in time. Check the connection and try again.";
  }
  if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(raw)) {
    return "Could not reach Clover. Check the connection and try again.";
  }
  return raw.slice(0, 300);
}

// ------------------------------------------------------------ pay-on-click ---

/**
 * Mints a session for one invoice, at the moment a client clicks Pay.
 *
 * Called by the `/share/invoice/[token]/pay` route rather than by the seam,
 * because the seam asks for a link when the invoice is sent and this one has
 * to be made later. Exported for that route and for its tests.
 */
export async function createCheckoutSession(
  invoice: {
    number: string;
    description: string;
    balanceCents: number;
    clientName: string;
    clientEmail: string | null;
    organizationName: string;
  },
  config: PaymentConfig,
  credentials: PaymentCredentials,
): Promise<ProviderResult<{ url: string }>> {
  if (invoice.balanceCents <= 0) {
    return { ok: false, error: "This invoice has nothing left to pay." };
  }

  const session = await createSession(
    {
      amountCents: invoice.balanceCents,
      name: invoice.description || `Invoice ${invoice.number}`,
      note: `${invoice.organizationName} — invoice ${invoice.number}`,
      clientName: invoice.clientName,
      clientEmail: invoice.clientEmail,
    },
    config,
    credentials,
  );

  if (!session.ok) return session;
  return { ok: true, value: { url: session.value.href! } };
}

// ---------------------------------------------------------------- adapter ---

export const cloverAdapter: PaymentAdapter = {
  async verify(config, credentials) {
    const merchantId = config.merchantId?.trim();
    if (!merchantId) {
      return { ok: false, error: "Enter the merchant ID from your Clover dashboard." };
    }

    // A real session, for a nominal amount, that nobody is ever given. It is
    // the only call that proves what matters: that this key, this merchant and
    // this integration type can actually open a checkout. Clover expires it
    // fifteen minutes later on its own, and no money can move without somebody
    // opening the page.
    const session = await createSession(
      {
        amountCents: 100,
        name: "Connection test",
        note: "Matlock One connection test — not a real charge",
        clientName: "Matlock One",
        clientEmail: null,
      },
      config,
      credentials,
    );
    if (!session.ok) return session;

    const sandbox = config.environment === "sandbox";
    return {
      ok: true,
      value: {
        accountLabel: sandbox
          ? `Clover ${merchantId} (sandbox)`
          : `Clover ${merchantId}`,
      },
    };
  },

  /**
   * Hands back our own page rather than a Clover address.
   *
   * Nothing is created at Clover here: a session made now would expire fifteen
   * minutes from now, and this link has to survive until the client opens
   * their email. The route behind this address makes one when they click.
   */
  async createLink(request: PaymentRequest, config) {
    if (!config.merchantId?.trim()) {
      return {
        ok: false,
        error:
          "No Clover merchant ID is configured. Reconnect the account under Settings → Payments.",
      };
    }

    // No ref: there is no single Clover object to ask about later, which is
    // the same reason this provider reconciles nothing.
    return { ok: true, value: { url: request.payPageUrl, ref: null } };
  },

  /**
   * Nothing to poll, and the settings screen says so before anyone connects.
   *
   * Each click creates its own session, so there is no per-invoice handle at
   * Clover to ask about. Returning an empty list rather than an error keeps
   * the reconcile sweep quiet for every other provider it runs beside.
   */
  async listPayments() {
    return { ok: true, value: [] };
  },
};

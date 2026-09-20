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
 * Stripe, through their Invoicing API.
 *
 * Invoicing rather than Checkout Sessions, for the same reason the PayPal
 * adapter avoids Orders: a Checkout Session expires within a day, and an
 * invoice with thirty-day terms is paid long after that. The link in the email
 * has to still work in week three. A finalized Stripe invoice has a hosted page
 * that stays up, needs no return URL, and reports what was paid against it.
 *
 * No return URL matters here as much as it does for PayPal: a desktop install
 * has no address Stripe could send a customer back to.
 *
 * Matlock One stays the system of record. The Stripe invoice carries a single
 * line — the outstanding balance — and names our invoice number. The itemised
 * document is ours, and Stripe never emails it: `auto_advance` is off and the
 * send endpoint is never called, because two invoices arriving from two senders
 * for the same money is how a client pays twice.
 */

const API = "https://api.stripe.com";

const TIMEOUT_MS = 20_000;

/** How long the hosted invoice stays payable before Stripe marks it overdue. */
const DAYS_UNTIL_DUE = 30;

/**
 * Where to send requests.
 *
 * The env override exists so the test suite can point this at a local fake and
 * exercise the real request and response handling. Deliberately an
 * operator-level environment variable rather than saved config: config is
 * editable from the settings screen, and a redirectable API base would be a way
 * to walk off with a live secret key.
 */
function apiBase() {
  const override = process.env.STRIPE_API_BASE;
  return override ? override.replace(/\/$/, "") : API;
}

/**
 * Test keys and live keys are the same shape to this code, and the difference
 * matters only for what gets shown to the person connecting the account.
 * Stripe's own keys carry it in the prefix, so nothing has to be asked for.
 */
function isTestKey(secretKey: string) {
  return /^(sk|rk)_test_/.test(secretKey);
}

// ------------------------------------------------------------------- http ---

type StripeError = {
  error?: { message?: string; code?: string; type?: string };
};

/**
 * Stripe's API is form-encoded, not JSON, and nests with bracket syntax:
 * `metadata[invoice]=INV-1102`. Values are flattened here rather than at each
 * call site so a nested key cannot be spelled two different ways.
 */
function encodeForm(form: Record<string, string | number | boolean | undefined>) {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(form)) {
    if (value === undefined) continue;
    body.set(key, String(value));
  }

  return body;
}

async function call<T>(
  credentials: PaymentCredentials,
  path: string,
  init: {
    method?: string;
    form?: Record<string, string | number | boolean | undefined>;
    /** Makes a retried create return the original object, not a second one. */
    idempotencyKey?: string;
  } = {},
): Promise<ProviderResult<T>> {
  const secretKey = credentials.secretKey?.trim();
  if (!secretKey) return { ok: false, error: "A Stripe secret key is required." };

  let response: Response;

  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(init.form
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
        ...(init.idempotencyKey
          ? { "Idempotency-Key": init.idempotencyKey }
          : {}),
      },
      body: init.form ? encodeForm(init.form) : undefined,
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
    // A gateway in front of Stripe can answer with HTML. Reporting a parse
    // error would blame the wrong thing.
    if (!response.ok) {
      return { ok: false, error: `Stripe returned ${response.status}.` };
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      error: describeApi(response.status, body as StripeError, secretKey),
    };
  }

  return { ok: true, value: body as T };
}

/** Turns Stripe's developer-facing errors into something actionable. */
function describeApi(status: number, body: StripeError | null, secretKey: string) {
  const said = body?.error?.message;

  if (status === 401) {
    // Overwhelmingly a key pasted from the wrong mode or a rotated one, and
    // both look identical in the settings form.
    const mode = isTestKey(secretKey) ? "test" : "live";
    return `Stripe rejected that secret key. It is a ${mode}-mode key — check it was copied whole from the same mode you meant, and that it has not been rolled.`;
  }
  if (status === 403) {
    return said
      ? `Stripe refused that request: ${said} A restricted key needs write access to Invoices and Customers.`
      : "Stripe refused that request. A restricted key needs write access to Invoices and Customers.";
  }
  if (status === 404) {
    return "Stripe no longer has that invoice. Remove the pay link and add a new one.";
  }
  if (status === 429) {
    return "Stripe is rate limiting requests. Wait a moment and try again.";
  }
  if (status >= 500) {
    return "Stripe is having trouble at their end. Try again shortly.";
  }

  return said ?? `Stripe returned ${status}.`;
}

function describeNetwork(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);

  if (/timeout|abort/i.test(raw)) {
    return "Stripe did not respond in time. Check the connection and try again.";
  }
  if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(raw)) {
    return "Could not reach Stripe. Check the connection and try again.";
  }
  return raw.slice(0, 300);
}

// --------------------------------------------------------------- responses ---

type StripeAccount = {
  id?: string;
  email?: string | null;
  business_profile?: { name?: string | null } | null;
  settings?: { dashboard?: { display_name?: string | null } | null } | null;
};

type StripeCustomer = { id?: string };

type StripeList<T> = { data?: T[] };

type StripeInvoice = {
  id?: string;
  hosted_invoice_url?: string | null;
  status?: string;
  amount_paid?: number;
  currency?: string;
  /** Older API versions expand this; newer ones report payments separately. */
  payment_intent?: string | { id?: string } | null;
  status_transitions?: { paid_at?: number | null } | null;
};

/**
 * The id of whatever settled the invoice.
 *
 * Used to deduplicate: payments are recorded under the processor's own id, so
 * polling twice must not record twice. Stripe has moved this field around
 * between API versions — a string on older ones, an expanded object on newer —
 * and a restricted key may not be allowed to read it at all. Falling back to
 * the invoice's own id keeps that last case idempotent, because an invoice
 * settles once.
 */
export function settlementId(invoice: StripeInvoice): string | null {
  const intent = invoice.payment_intent;

  if (typeof intent === "string" && intent) return intent;
  if (intent && typeof intent === "object" && intent.id) return intent.id;

  return invoice.id ? `${invoice.id}:paid` : null;
}

// ---------------------------------------------------------------- adapter ---

export const stripeAdapter: PaymentAdapter = {
  async verify(_config: PaymentConfig, credentials) {
    // The probe is the API this adapter actually uses, not the account
    // endpoint. A restricted key with Invoices write but no account read is a
    // perfectly good key for this, and testing the wrong endpoint would refuse
    // a connection that works.
    const probe = await call<StripeList<StripeInvoice>>(
      credentials,
      "/v1/invoices?limit=1",
    );
    if (!probe.ok) return probe;

    const mode = isTestKey(credentials.secretKey ?? "") ? "test mode" : "live";

    // Best effort: the name makes the connected account recognisable in
    // settings, but failing to read it is not a reason to refuse a key that
    // can already do the job.
    const account = await call<StripeAccount>(credentials, "/v1/account");
    const name =
      (account.ok &&
        (account.value?.settings?.dashboard?.display_name ||
          account.value?.business_profile?.name ||
          account.value?.email)) ||
      null;

    return {
      ok: true,
      value: { accountLabel: name ? `${name} (${mode})` : `Stripe (${mode})` },
    };
  },

  async createLink(request: PaymentRequest, _config, credentials) {
    const currency = request.currency.toLowerCase();

    // One Stripe customer per client email, reused across their invoices, so a
    // business's Stripe dashboard does not fill up with one customer per
    // document. Without an email there is nothing to match on, and a fresh
    // customer is the only option.
    let customerId: string | null = null;

    if (request.clientEmail) {
      const found = await call<StripeList<StripeCustomer>>(
        credentials,
        `/v1/customers?limit=1&email=${encodeURIComponent(request.clientEmail)}`,
      );
      if (!found.ok) return found;
      customerId = found.value?.data?.[0]?.id ?? null;
    }

    if (!customerId) {
      const created = await call<StripeCustomer>(credentials, "/v1/customers", {
        method: "POST",
        form: {
          name: request.clientName,
          email: request.clientEmail ?? undefined,
        },
      });
      if (!created.ok) return created;

      customerId = created.value?.id ?? null;
      if (!customerId) {
        return {
          ok: false,
          error: "Stripe created the customer but did not return its id.",
        };
      }
    }

    // Draft first, then the line attached to it by id. The other order — a
    // pending invoice item swept up by the next invoice created — would also
    // collect anything else left pending on that customer.
    const invoice = await call<StripeInvoice>(credentials, "/v1/invoices", {
      method: "POST",
      form: {
        customer: customerId,
        currency,
        collection_method: "send_invoice",
        days_until_due: DAYS_UNTIL_DUE,
        // Stripe must not chase or email this. Matlock One sends the document.
        auto_advance: false,
        description: `${request.organizationName} — invoice ${request.invoiceNumber}`,
        "metadata[matlock_invoice]": request.invoiceNumber,
      },
      // Keyed on the number and the balance, so a double-click returns the
      // first invoice rather than raising a second one at the same client.
      idempotencyKey: `matlock-inv-${request.invoiceNumber}-${request.amountCents}`,
    });
    if (!invoice.ok) return invoice;

    const invoiceId = invoice.value?.id;
    if (!invoiceId) {
      return {
        ok: false,
        error: "Stripe accepted the invoice but did not return its id.",
      };
    }

    const item = await call<{ id?: string }>(credentials, "/v1/invoiceitems", {
      method: "POST",
      form: {
        customer: customerId,
        invoice: invoiceId,
        // Always the outstanding balance, in the smallest unit of the
        // currency — which is what the rest of the application stores.
        amount: request.amountCents,
        currency,
        description: request.description.slice(0, 500),
      },
      idempotencyKey: `matlock-item-${request.invoiceNumber}-${request.amountCents}`,
    });
    if (!item.ok) return item;

    // A draft has no payable page. Finalizing is what produces one.
    const finalized = await call<StripeInvoice>(
      credentials,
      `/v1/invoices/${invoiceId}/finalize_invoice`,
      { method: "POST", form: { auto_advance: false } },
    );
    if (!finalized.ok) return finalized;

    const url = finalized.value?.hosted_invoice_url;
    if (!url) {
      return {
        ok: false,
        error:
          "Stripe finalized the invoice but returned no payment page. Check the invoice in your Stripe dashboard.",
      };
    }

    return { ok: true, value: { url, ref: invoiceId } };
  },

  async listPayments(ref, _config, credentials) {
    if (!ref) {
      return {
        ok: false,
        error: "This invoice has no Stripe request to check. Add a pay link first.",
      };
    }

    const result = await call<StripeInvoice>(credentials, `/v1/invoices/${ref}`);
    if (!result.ok) return result;

    const invoice = result.value ?? {};
    const amountCents = invoice.amount_paid ?? 0;

    // Nothing settled yet is a normal answer, not a failure.
    if (amountCents <= 0) return { ok: true, value: [] };

    const externalId = settlementId(invoice);
    if (!externalId) return { ok: true, value: [] };

    // Stripe reports timestamps as unix seconds.
    const paidSeconds = invoice.status_transitions?.paid_at;
    const paidAt = paidSeconds ? new Date(paidSeconds * 1000) : new Date();

    const payments: RemotePayment[] = [
      {
        externalId,
        amountCents,
        paidAt: Number.isNaN(paidAt.getTime()) ? new Date() : paidAt,
        reference: invoice.status ?? null,
      },
    ];

    return { ok: true, value: payments };
  },
};

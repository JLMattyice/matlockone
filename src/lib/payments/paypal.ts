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
 * PayPal, through their Invoicing API.
 *
 * Invoicing rather than Orders/Checkout on purpose: a checkout order expires
 * within hours, which is useless for a document someone pays three weeks after
 * it lands in their inbox. A PayPal invoice is long-lived, carries a shareable
 * link that needs no return URL, and reports what has been paid against it —
 * including a payment the merchant recorded outside PayPal.
 *
 * No return URL matters more than it sounds: the desktop build has no address
 * PayPal could redirect a customer back to, so any flow that depends on the
 * buyer returning to Matlock One cannot work here.
 *
 * Matlock One stays the system of record. The PayPal invoice carries one line —
 * the outstanding balance — and points back at our number. The itemised
 * document is ours.
 */

const LIVE = "https://api-m.paypal.com";
const SANDBOX = "https://api-m.sandbox.paypal.com";

const TIMEOUT_MS = 20_000;

/**
 * The permission an app needs before it may touch the Invoicing API.
 *
 * PayPal grants it per *app*, not per account: the feature has to be ticked on
 * the app in the developer dashboard, and until it is, the access token comes
 * back without this in its scope list and every Invoicing call is refused.
 */
const INVOICING_SCOPE = "https://uri.paypal.com/services/invoicing";

const MISSING_INVOICING = [
  "That PayPal app is not permitted to use Invoicing.",
  "Open developer.paypal.com → Apps & Credentials, switch to the same environment as above,",
  "open the app, tick Invoicing under Features, save, then test again here.",
  "Live invoicing also needs a PayPal Business account — a Personal one cannot invoice.",
].join(" ");

/**
 * Where to send requests.
 *
 * The env override exists so the test suite can point this at a local fake and
 * exercise the real request and response handling. It is deliberately an
 * operator-level environment variable rather than something in the saved
 * config: config is editable from the settings screen, and a redirectable API
 * base would be a way to walk off with the credentials.
 */
function apiBase(config: PaymentConfig) {
  const override = process.env.PAYPAL_API_BASE;
  if (override) return override.replace(/\/$/, "");
  return config.environment === "sandbox" ? SANDBOX : LIVE;
}

// ------------------------------------------------------------------ money ---

/** Cents to the decimal string PayPal wants, e.g. 89735 -> "897.35". */
function toDecimal(cents: number) {
  return (cents / 100).toFixed(2);
}

/**
 * PayPal's decimal string back to cents.
 *
 * Rounded rather than truncated: 897.35 * 100 lands on 89734.999… in binary
 * floating point, and truncating would quietly lose a cent on a payment.
 */
function toCents(value: string | number | undefined | null) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

// ------------------------------------------------------------------- auth ---

type Token = { token: string; scopes: string[] };
type CachedToken = Token & { expiresAt: number };

/**
 * Access tokens last hours, so they are cached per credential rather than
 * fetched on every call. Keyed by client id, and the cache is dropped a minute
 * early so a token never expires mid-request.
 */
const tokenCache = new Map<string, CachedToken>();

async function accessToken(
  config: PaymentConfig,
  credentials: PaymentCredentials,
  options: { fresh?: boolean } = {},
): Promise<ProviderResult<Token>> {
  const clientId = credentials.clientId?.trim();
  const clientSecret = credentials.clientSecret?.trim();

  if (!clientId || !clientSecret) {
    return { ok: false, error: "PayPal client ID and secret are required." };
  }

  const cacheKey = `${apiBase(config)}:${clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) {
    return { ok: true, value: { token: cached.token, scopes: cached.scopes } };
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  let response: Response;
  try {
    response = await fetch(`${apiBase(config)}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: describeNetwork(error) };
  }

  const body = (await response.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    /** Space-separated list of what this app is actually allowed to do. */
    scope?: string;
  } | null;

  if (!response.ok || !body?.access_token) {
    if (response.status === 401) {
      return {
        ok: false,
        error:
          "PayPal rejected those credentials. Check the client ID and secret, and that they match the environment selected above — a sandbox key will not work against live.",
      };
    }
    return {
      ok: false,
      error: body?.error_description ?? `PayPal returned ${response.status}.`,
    };
  }

  const scopes = (body.scope ?? "").split(" ").filter(Boolean);

  tokenCache.set(cacheKey, {
    token: body.access_token,
    scopes,
    expiresAt: Date.now() + Math.max((body.expires_in ?? 3600) - 60, 60) * 1000,
  });

  return { ok: true, value: { token: body.access_token, scopes } };
}

/**
 * Drops cached tokens, so a credential change takes effect immediately.
 *
 * With no argument it clears the lot. The cache is keyed by client id, so
 * rotating only the *secret* would otherwise keep handing back a token minted
 * from the old one for the rest of its nine-hour life.
 */
export function forgetPaypalToken(clientId?: string) {
  if (!clientId) {
    tokenCache.clear();
    return;
  }
  for (const key of tokenCache.keys()) {
    if (key.endsWith(`:${clientId}`)) tokenCache.delete(key);
  }
}

// ------------------------------------------------------------------- http ---

type PaypalError = {
  name?: string;
  message?: string;
  details?: { issue?: string; description?: string }[];
};

async function call<T>(
  config: PaymentConfig,
  token: string,
  path: string,
  init: { method: string; body?: unknown; requestId?: string } = {
    method: "GET",
  },
): Promise<ProviderResult<T>> {
  let response: Response;

  try {
    response = await fetch(`${apiBase(config)}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Makes a retried create return the original invoice rather than a
        // second one. A double-click must not bill the customer twice.
        ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: describeNetwork(error) };
  }

  // 204 and other empty successes are normal on send/cancel.
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    return { ok: false, error: describeApi(response.status, body as PaypalError) };
  }

  return { ok: true, value: body as T };
}

/** Turns PayPal's developer-facing errors into something actionable. */
function describeApi(status: number, body: PaypalError | null) {
  const issue = body?.details?.[0]?.issue;
  const description = body?.details?.[0]?.description;

  if (status === 401) {
    return "PayPal rejected the credentials. Reconnect the account under Settings → Payments.";
  }
  if (status === 403) {
    // Every 403 used to be reported as a missing Invoicing feature. That is by
    // far the usual cause, but not the only one — a Personal account cannot
    // invoice at all, and a live app can be refused for reasons of PayPal's
    // own. Reporting the guess while throwing PayPal's own explanation away
    // sends people to fix something that was never broken, so the explanation
    // now travels with the guess.
    const said = description ?? body?.message;
    const permission = /NOT_AUTHORIZED|PERMISSION|SCOPE/i.test(
      `${body?.name ?? ""} ${issue ?? ""}`,
    );

    if (permission || !said) {
      return said ? `${MISSING_INVOICING} PayPal said: ${said}` : MISSING_INVOICING;
    }
    return `PayPal refused that request: ${said}`;
  }
  if (issue === "DUPLICATE_INVOICE_NUMBER") {
    return "PayPal already has an invoice with this number. Remove the existing pay link, or change the invoice number.";
  }
  if (status === 429) {
    return "PayPal is rate limiting requests. Wait a moment and try again.";
  }
  if (status >= 500) {
    return "PayPal is having trouble at their end. Try again shortly.";
  }

  return description ?? body?.message ?? `PayPal returned ${status}.`;
}

function describeNetwork(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);

  if (/timeout|abort/i.test(raw)) {
    return "PayPal did not respond in time. Check the connection and try again.";
  }
  if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(raw)) {
    return "Could not reach PayPal. Check the connection and try again.";
  }
  return raw.slice(0, 300);
}

// --------------------------------------------------------------- responses ---

type PaypalInvoice = {
  id?: string;
  /** Creating an invoice answers with a link to it, not with an id field. */
  href?: string;
  status?: string;
  detail?: { metadata?: { recipient_view_url?: string } };
  links?: { rel?: string; href?: string }[];
  payments?: {
    transactions?: {
      payment_id?: string;
      amount?: { value?: string };
      payment_date?: string;
      method?: string;
    }[];
  };
};

/**
 * The invoice id from a create response.
 *
 * POST /v2/invoicing/invoices does not answer with an `id`. It answers with a
 * link to the new invoice — `{ rel: "self", href: ".../invoices/INV2-..." }` —
 * and the id has to be read off the end of it.
 *
 * This cost real money to learn: reading only `id` meant every create appeared
 * to fail, so the invoice was never published, no payable link came back, and a
 * dangling draft was left in the merchant's PayPal account on every attempt.
 * The local fake returned an `id`, which is to say it agreed with the mistake.
 * Both shapes are accepted now, because the one thing that is certain is that
 * this reading of their API might be wrong again.
 */
export function invoiceIdFrom(body: PaypalInvoice | null): string | null {
  if (body?.id) return body.id;

  const href =
    body?.href ?? body?.links?.find((link) => link.rel === "self")?.href;
  if (!href) return null;

  const id = href.split("?")[0].split("/").filter(Boolean).pop();
  return id && /^INV2-/i.test(id) ? id : (id ?? null);
}

/**
 * The customer-facing address for an invoice.
 *
 * PayPal puts it in metadata on a sent invoice, but returns it as a `payer-view`
 * link on some responses, so both are checked rather than assuming one shape.
 */
function payerUrl(invoice: PaypalInvoice) {
  return (
    invoice.detail?.metadata?.recipient_view_url ??
    invoice.links?.find((link) => link.rel === "payer-view")?.href ??
    null
  );
}

// ---------------------------------------------------------------- adapter ---

export const paypalAdapter: PaymentAdapter = {
  forget: () => forgetPaypalToken(),

  async verify(config, credentials) {
    // Deliberately never a cached token. "Test" is what somebody presses right
    // after changing something at PayPal's end — most often ticking Invoicing
    // on the app. A cached token was minted under the old permissions and
    // lasts nine hours, so reusing it here would report the same failure and
    // make a change that did work look as though it had not.
    const token = await accessToken(config, credentials, { fresh: true });
    if (!token.ok) return token;

    // PayPal states in the token response what the app is allowed to do, so
    // the commonest misconfiguration can be named exactly rather than inferred
    // from a 403 that has several possible causes.
    //
    // Only when a scope list actually came back: treating an absent list as
    // "not permitted" would invent a failure out of a response shape.
    if (token.value.scopes.length > 0 && !token.value.scopes.includes(INVOICING_SCOPE)) {
      return { ok: false, error: MISSING_INVOICING };
    }

    // The scope list can still be optimistic — the account behind the app has
    // to be able to invoice too. One real call is the only proof of that.
    const probe = await call<unknown>(
      config,
      token.value.token,
      "/v2/invoicing/invoices?page_size=1",
    );
    if (!probe.ok) return probe;

    const live = config.environment !== "sandbox";
    return {
      ok: true,
      value: {
        accountLabel: live ? "PayPal (live)" : "PayPal (sandbox)",
      },
    };
  },

  async createLink(request: PaymentRequest, config, credentials) {
    const token = await accessToken(config, credentials);
    if (!token.ok) return token;

    const amount = toDecimal(request.amountCents);

    // PayPal generates its own invoice number. Ours goes in the reference and
    // the line description instead: PayPal enforces uniqueness on its number
    // per merchant, and colliding on it would block re-issuing a link.
    const draft = {
      detail: {
        currency_code: request.currency,
        reference: request.invoiceNumber,
        note: `${request.organizationName} — invoice ${request.invoiceNumber}`,
      },
      ...(request.clientEmail
        ? {
            primary_recipients: [
              { billing_info: { email_address: request.clientEmail } },
            ],
          }
        : {}),
      items: [
        {
          name: `Invoice ${request.invoiceNumber}`.slice(0, 200),
          description: request.description.slice(0, 1000),
          quantity: "1",
          unit_amount: { currency_code: request.currency, value: amount },
        },
      ],
    };

    const created = await call<PaypalInvoice>(
      config,
      token.value.token,
      "/v2/invoicing/invoices",
      {
        method: "POST",
        body: draft,
        // Idempotency key on PayPal's side, not a display name: the prefix is
        // deliberately left at the name the app shipped under. Renaming it
        // would make PayPal treat a re-issued link for an invoice created
        // before the rename as a brand-new request, and raise a second
        // invoice at the same client for the same money.
        requestId: `worksuite-${request.invoiceNumber}-${request.amountCents}`,
      },
    );
    if (!created.ok) return created;

    const id = invoiceIdFrom(created.value ?? null);
    if (!id) {
      return {
        ok: false,
        error:
          "PayPal accepted the invoice but did not say where it went. Check your PayPal account for a draft before trying again.",
      };
    }

    // Publishing it is what produces a payable link. send_to_recipient is
    // false because Matlock One sends its own email — two invoices arriving from
    // two senders for the same money is how clients end up paying twice.
    const sent = await call<PaypalInvoice>(
      config,
      token.value.token,
      `/v2/invoicing/invoices/${id}/send`,
      { method: "POST", body: { send_to_recipient: false } },
    );
    if (!sent.ok) return sent;

    // The send response usually carries the payer link. When it does not, one
    // read-back gets it rather than leaving the invoice linked to nothing.
    let url = payerUrl(sent.value ?? {});

    if (!url) {
      const reread = await call<PaypalInvoice>(
        config,
        token.value.token,
        `/v2/invoicing/invoices/${id}`,
      );
      if (reread.ok) url = payerUrl(reread.value ?? {});
    }

    if (!url) {
      return {
        ok: false,
        error:
          "PayPal created the invoice but returned no payment link. Check the invoice in your PayPal account.",
      };
    }

    return { ok: true, value: { url, ref: id } };
  },

  async listPayments(ref, config, credentials) {
    if (!ref) {
      return {
        ok: false,
        error: "This invoice has no PayPal request to check. Add a pay link first.",
      };
    }

    const token = await accessToken(config, credentials);
    if (!token.ok) return token;

    const result = await call<PaypalInvoice>(
      config,
      token.value.token,
      `/v2/invoicing/invoices/${ref}`,
    );
    if (!result.ok) return result;

    const transactions = result.value?.payments?.transactions ?? [];

    const payments: RemotePayment[] = [];
    for (const transaction of transactions) {
      const amountCents = toCents(transaction.amount?.value);
      // Without an id there is nothing to deduplicate on, and recording it
      // would mean re-recording it on every future check.
      if (!transaction.payment_id || amountCents <= 0) continue;

      const paidAt = new Date(transaction.payment_date ?? Date.now());

      payments.push({
        externalId: transaction.payment_id,
        amountCents,
        paidAt: Number.isNaN(paidAt.getTime()) ? new Date() : paidAt,
        reference: transaction.method ?? null,
      });
    }

    return { ok: true, value: payments };
  },
};

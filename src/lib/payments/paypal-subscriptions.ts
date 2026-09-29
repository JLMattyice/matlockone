import "server-only";

import { accessToken, call } from "./paypal";
import type {
  PaymentConfig,
  PaymentCredentials,
  ProviderResult,
  RemotePayment,
} from "./providers";

/**
 * PayPal Subscriptions, on the business's own PayPal account.
 *
 * What auto-pay for a repeating invoice runs on. The business's customer
 * approves a subscription once, on PayPal's pages, and PayPal charges them
 * every period after that. Not to be confused with src/lib/checkout/paypal.ts,
 * which is Matlock One charging the business on Matlock One's own account.
 *
 * Like the rest of the payments seam, nothing here waits to be told: the
 * morning run asks PayPal what each subscription is doing and what it has
 * collected, because a webhook needs an address PayPal can reach and a
 * desktop copy has none.
 */

type Session = { config: PaymentConfig; credentials: PaymentCredentials };

/** PayPal's unit for each rhythm a repeating invoice can have, and its limit. */
const CYCLES = {
  WEEKLY: { unit: "WEEK", max: 52 },
  MONTHLY: { unit: "MONTH", max: 12 },
  YEARLY: { unit: "YEAR", max: 1 },
} as const;

/**
 * The billing cycle PayPal would use, or why it cannot.
 *
 * PayPal will bill every 1–52 weeks, every 1–12 months, or every year, and no
 * longer apart than that; a repeat outside those cannot be put on auto-pay.
 */
export function paypalCycle(
  frequency: string,
  interval: number,
): { ok: true; unit: string; count: number } | { ok: false; error: string } {
  const cycle = CYCLES[frequency as keyof typeof CYCLES];
  if (!cycle) return { ok: false, error: "PayPal cannot bill on that rhythm." };

  if (interval < 1 || interval > cycle.max) {
    return {
      ok: false,
      error:
        frequency === "YEARLY"
          ? "PayPal auto-pay can bill once a year at most apart, not every few years."
          : `PayPal auto-pay can bill at most every ${cycle.max} ${cycle.unit.toLowerCase()}s apart.`,
    };
  }

  return { ok: true, unit: cycle.unit, count: interval };
}

const decimal = (cents: number) => (cents / 100).toFixed(2);

const cents = (value: string | number | undefined | null) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

async function token(session: Session): Promise<ProviderResult<string>> {
  const result = await accessToken(session.config, session.credentials);
  return result.ok ? { ok: true, value: result.value.token } : result;
}

// ------------------------------------------------------------------- plan ---

/**
 * Makes the product and plan a subscription is charged on.
 *
 * One pair per offer: the amount and rhythm are fixed on a PayPal plan, and
 * this customer's price is theirs. The request ids make a retried offer — a
 * double click, a timeout that in fact succeeded — return the plan already
 * made instead of a second one.
 */
export async function createAutopayPlan(
  session: Session,
  input: {
    /** Unique per offer, for PayPal's idempotency. */
    key: string;
    name: string;
    description: string;
    amountCents: number;
    currency: string;
    frequency: string;
    interval: number;
  },
): Promise<ProviderResult<{ planId: string }>> {
  const cycle = paypalCycle(input.frequency, input.interval);
  if (!cycle.ok) return cycle;

  const bearer = await token(session);
  if (!bearer.ok) return bearer;

  const product = await call<{ id?: string }>(session.config, bearer.value, "/v1/catalogs/products", {
    method: "POST",
    feature: "subscriptions",
    requestId: `matlock-autopay-product-${input.key}`,
    body: {
      name: clip(input.name, 127),
      description: clip(input.description, 256),
      type: "SERVICE",
    },
  });
  if (!product.ok) return product;
  if (!product.value?.id) {
    return { ok: false, error: "PayPal did not say what the new product was called. Try again." };
  }

  const plan = await call<{ id?: string }>(session.config, bearer.value, "/v1/billing/plans", {
    method: "POST",
    feature: "subscriptions",
    requestId: `matlock-autopay-plan-${input.key}`,
    body: {
      product_id: product.value.id,
      name: clip(input.name, 127),
      description: clip(input.description, 127),
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: cycle.unit, interval_count: cycle.count },
          tenure_type: "REGULAR",
          sequence: 1,
          // Until cancelled. The schedule's end date is kept by cancelling.
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: decimal(input.amountCents), currency_code: input.currency },
          },
        },
      ],
      payment_preferences: {
        // A missed payment is added to the next one rather than dropped.
        auto_bill_outstanding: true,
        // Three failures in a row and PayPal suspends it, which the morning
        // run notices and tells the business about.
        payment_failure_threshold: 3,
      },
    },
  });
  if (!plan.ok) return plan;
  if (!plan.value?.id) {
    return { ok: false, error: "PayPal did not say what the new plan was called. Try again." };
  }

  return { ok: true, value: { planId: plan.value.id } };
}

// ----------------------------------------------------------- subscription ---

/**
 * A subscription waiting for the customer to approve it, and where to send
 * them to do so.
 *
 * Made at the moment the customer clicks the invite, never ahead of time:
 * PayPal's approval link goes stale within hours.
 */
export async function startAutopaySubscription(
  session: Session,
  input: {
    planId: string;
    /** Ours, handed back on the subscription: the schedule it pays for. */
    customId: string;
    startTime: Date;
    brandName: string;
    email: string | null;
    /**
     * How many payments to take before stopping by itself, for a repeat with
     * an end date. Null for one that goes on until it is cancelled.
     */
    totalPayments: number | null;
    /** The plan's own price, restated when the count is set on it. */
    amountCents: number;
    currency: string;
    returnUrl: string;
    cancelUrl: string;
  },
): Promise<ProviderResult<{ id: string; approveUrl: string; status: string }>> {
  const bearer = await token(session);
  if (!bearer.ok) return bearer;

  const created = await call<{
    id?: string;
    status?: string;
    links?: { rel?: string; href?: string }[];
  }>(session.config, bearer.value, "/v1/billing/subscriptions", {
    method: "POST",
    feature: "subscriptions",
    body: {
      plan_id: input.planId,
      custom_id: input.customId,
      start_time: input.startTime.toISOString(),
      ...(input.email ? { subscriber: { email_address: input.email } } : {}),
      // The plan says "until cancelled"; a repeat that ends is given its
      // count on this customer's subscription alone, so PayPal stops after
      // the last one without anybody remembering to cancel it.
      ...(input.totalPayments
        ? {
            plan: {
              billing_cycles: [
                {
                  sequence: 1,
                  total_cycles: input.totalPayments,
                  pricing_scheme: {
                    fixed_price: { value: decimal(input.amountCents), currency_code: input.currency },
                  },
                },
              ],
            },
          }
        : {}),
      application_context: {
        brand_name: clip(input.brandName, 127),
        user_action: "SUBSCRIBE_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: input.returnUrl,
        cancel_url: input.cancelUrl,
      },
    },
  });
  if (!created.ok) return created;

  const approveUrl = created.value?.links?.find((link) => link.rel === "approve")?.href;
  if (!created.value?.id || !approveUrl) {
    return { ok: false, error: "PayPal did not return a page to approve the payments on." };
  }

  return {
    ok: true,
    value: {
      id: created.value.id,
      approveUrl,
      status: created.value.status ?? "APPROVAL_PENDING",
    },
  };
}

export type AutopayState = {
  /** APPROVAL_PENDING, APPROVED, ACTIVE, SUSPENDED, CANCELLED or EXPIRED. */
  status: string;
  payerEmail: string | null;
};

/** What PayPal says the subscription is doing now. */
export async function getAutopaySubscription(
  session: Session,
  id: string,
): Promise<ProviderResult<AutopayState>> {
  const bearer = await token(session);
  if (!bearer.ok) return bearer;

  const found = await call<{ status?: string; subscriber?: { email_address?: string } }>(
    session.config,
    bearer.value,
    `/v1/billing/subscriptions/${encodeURIComponent(id)}`,
    { method: "GET", feature: "subscriptions" },
  );
  if (!found.ok) return found;
  if (!found.value?.status) return { ok: false, error: "PayPal did not say what state it is in." };

  return {
    ok: true,
    value: {
      status: found.value.status,
      payerEmail: found.value.subscriber?.email_address ?? null,
    },
  };
}

/**
 * Every payment PayPal collected on the subscription between two times.
 *
 * Only completed ones. A declined attempt took nothing, and a pending one
 * has not landed yet — it will be completed on a later look.
 */
export async function listAutopayPayments(
  session: Session,
  id: string,
  from: Date,
  until: Date,
): Promise<ProviderResult<RemotePayment[]>> {
  const bearer = await token(session);
  if (!bearer.ok) return bearer;

  const query = new URLSearchParams({
    start_time: from.toISOString(),
    end_time: until.toISOString(),
  });

  const listed = await call<{
    transactions?: {
      id?: string;
      status?: string;
      time?: string;
      amount_with_breakdown?: { gross_amount?: { value?: string } };
    }[];
  }>(
    session.config,
    bearer.value,
    `/v1/billing/subscriptions/${encodeURIComponent(id)}/transactions?${query}`,
    { method: "GET", feature: "subscriptions" },
  );
  if (!listed.ok) return listed;

  const payments: RemotePayment[] = [];
  for (const transaction of listed.value?.transactions ?? []) {
    if (transaction.status !== "COMPLETED" || !transaction.id) continue;

    const amountCents = cents(transaction.amount_with_breakdown?.gross_amount?.value);
    if (amountCents <= 0) continue;

    const paidAt = new Date(transaction.time ?? "");
    payments.push({
      externalId: transaction.id,
      amountCents,
      paidAt: Number.isNaN(paidAt.getTime()) ? new Date() : paidAt,
      reference: "PayPal auto-pay",
    });
  }

  return { ok: true, value: payments };
}

/**
 * Stops the subscription, so PayPal charges nothing more.
 *
 * One that is already over counts as stopped. PayPal refuses to cancel a
 * subscription that was never approved, and one the customer cancelled
 * themselves; either way the answer to "will it charge again" is no.
 */
export async function cancelAutopaySubscription(
  session: Session,
  id: string,
  reason: string,
): Promise<ProviderResult<null>> {
  const bearer = await token(session);
  if (!bearer.ok) return bearer;

  const cancelled = await call<unknown>(
    session.config,
    bearer.value,
    `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`,
    { method: "POST", feature: "subscriptions", body: { reason: clip(reason, 127) } },
  );
  if (cancelled.ok) return { ok: true, value: null };

  const now = await getAutopaySubscription(session, id);
  if (now.ok && !["ACTIVE", "SUSPENDED", "APPROVED"].includes(now.value.status)) {
    return { ok: true, value: null };
  }

  return cancelled;
}

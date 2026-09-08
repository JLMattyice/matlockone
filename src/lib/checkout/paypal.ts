import "server-only";

import { isPlan } from "./plans";
import type { LicensePlan } from "@/lib/license/token";

/**
 * PayPal Subscriptions — how Matlock One is bought.
 *
 * Not the same integration as `src/lib/payments/paypal.ts`. That one creates a
 * payment link so a *customer* can collect one invoice from their client. This
 * one is recurring billing for the product itself: different API, different
 * lifecycle, and webhooks are usable here because the hosted site has an
 * address PayPal can reach, which a desktop install never does.
 *
 * Billing plans are created once in the PayPal dashboard and their ids put in
 * the environment. Creating them from code would mean this deployment could
 * silently invent a second "Business, monthly" plan at a different price, and
 * reconciling that afterwards is not a job anyone wants.
 */

export type PayPalInterval = "monthly" | "annual";

export type PayPalConfig = {
  clientId: string;
  clientSecret: string;
  /** Sandbox until the day it is not. */
  live: boolean;
  webhookId: string;
  /** Our plan + interval → PayPal's billing plan id. */
  planIds: Partial<Record<`${LicensePlan}_${PayPalInterval}`, string>>;
};

const LIVE = "https://api-m.paypal.com";
const SANDBOX = "https://api-m.sandbox.paypal.com";

export function apiBase(config: PayPalConfig): string {
  return config.live ? LIVE : SANDBOX;
}

/**
 * Reads the configuration, or returns null when this deployment does not sell.
 *
 * Null rather than a throw: a desktop install and a developer's laptop both
 * legitimately have no PayPal credentials, and neither should crash on a
 * request that happens to touch this module.
 */
export function paypalConfig(): PayPalConfig | null {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim();

  if (!clientId || !clientSecret || !webhookId) return null;

  return {
    clientId,
    clientSecret,
    live: process.env.PAYPAL_ENV?.trim().toLowerCase() === "live",
    webhookId,
    planIds: {
      starter_monthly: process.env.PAYPAL_PLAN_STARTER_MONTHLY?.trim(),
      starter_annual: process.env.PAYPAL_PLAN_STARTER_ANNUAL?.trim(),
      business_monthly: process.env.PAYPAL_PLAN_BUSINESS_MONTHLY?.trim(),
      business_annual: process.env.PAYPAL_PLAN_BUSINESS_ANNUAL?.trim(),
      pro_monthly: process.env.PAYPAL_PLAN_PRO_MONTHLY?.trim(),
      pro_annual: process.env.PAYPAL_PLAN_PRO_ANNUAL?.trim(),
    },
  };
}

export function isPayPalConfigured(): boolean {
  return paypalConfig() !== null;
}

/** PayPal's billing plan id for one of ours, or null when it is not for sale. */
export function planIdFor(
  config: PayPalConfig,
  plan: LicensePlan,
  interval: PayPalInterval,
): string | null {
  return config.planIds[`${plan}_${interval}`] ?? null;
}

/**
 * The reverse: which of our plans a PayPal billing plan id refers to.
 *
 * Done by lookup rather than by trusting anything in the webhook body. A
 * payload naming its own plan would let whoever can reach the endpoint choose
 * what they bought.
 */
export function planForPayPalId(
  config: PayPalConfig,
  paypalPlanId: string,
): { plan: LicensePlan; interval: PayPalInterval } | null {
  for (const [key, id] of Object.entries(config.planIds)) {
    if (!id || id !== paypalPlanId) continue;

    const [plan, interval] = key.split("_") as [LicensePlan, PayPalInterval];
    if (isPlan(plan)) return { plan, interval };
  }

  return null;
}

// ----------------------------------------------------------------- tokens ---

type TokenCache = { token: string; expiresAt: number };
let cached: TokenCache | null = null;

/**
 * An OAuth token, reused until shortly before it expires.
 *
 * PayPal's tokens last hours. Fetching one per webhook would add a round trip
 * to every delivery and invite rate limiting during a burst of renewals.
 */
export async function accessToken(config: PayPalConfig): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.token;

  const credentials = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
  ).toString("base64");

  const response = await fetch(`${apiBase(config)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(
      `PayPal refused the credentials (${response.status}). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, and whether PAYPAL_ENV matches the account.`,
    );
  }

  const body = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  cached = {
    token: body.access_token,
    // A minute of headroom, so a token cannot expire mid-request.
    expiresAt: now + (body.expires_in - 60) * 1000,
  };

  return cached.token;
}

/** Only for tests and for a credential change taking effect immediately. */
export function forgetAccessToken() {
  cached = null;
}

// --------------------------------------------------------------- checkout ---

export type StartResult =
  | { ok: true; approveUrl: string; subscriptionId: string }
  | { ok: false; error: string };

/**
 * Starts a subscription and returns where to send the buyer.
 *
 * No card details reach this application, exactly as with invoice payments:
 * the buyer approves on PayPal's own pages, on PayPal's domain.
 */
export async function startSubscription(
  config: PayPalConfig,
  input: {
    plan: LicensePlan;
    interval: PayPalInterval;
    returnUrl: string;
    cancelUrl: string;
    email?: string | null;
  },
): Promise<StartResult> {
  const planId = planIdFor(config, input.plan, input.interval);
  if (!planId) {
    return {
      ok: false,
      error: `No PayPal billing plan is configured for ${input.plan} ${input.interval}.`,
    };
  }

  try {
    const token = await accessToken(config);

    const response = await fetch(`${apiBase(config)}/v1/billing/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plan_id: planId,
        ...(input.email ? { subscriber: { email_address: input.email } } : {}),
        application_context: {
          brand_name: "Matlock One",
          user_action: "SUBSCRIBE_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const body = (await response.json()) as {
      id?: string;
      links?: { rel: string; href: string }[];
      message?: string;
    };

    if (!response.ok || !body.id) {
      return {
        ok: false,
        error: body.message ?? `PayPal declined the subscription (${response.status}).`,
      };
    }

    const approve = body.links?.find((link) => link.rel === "approve")?.href;
    if (!approve) {
      return { ok: false, error: "PayPal did not return an approval link." };
    }

    return { ok: true, approveUrl: approve, subscriptionId: body.id };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Could not reach PayPal: ${error.message}`
          : "Could not reach PayPal.",
    };
  }
}

// --------------------------------------------------------------- webhooks ---

export type WebhookHeaders = {
  transmissionId?: string | null;
  transmissionTime?: string | null;
  transmissionSig?: string | null;
  certUrl?: string | null;
  authAlgo?: string | null;
};

/** Pulls the five headers PayPal signs with, whatever their casing. */
export function webhookHeaders(headers: Headers): WebhookHeaders {
  return {
    transmissionId: headers.get("paypal-transmission-id"),
    transmissionTime: headers.get("paypal-transmission-time"),
    transmissionSig: headers.get("paypal-transmission-sig"),
    certUrl: headers.get("paypal-cert-url"),
    authAlgo: headers.get("paypal-auth-algo"),
  };
}

export function hasWebhookHeaders(headers: WebhookHeaders): boolean {
  return Boolean(
    headers.transmissionId &&
      headers.transmissionTime &&
      headers.transmissionSig &&
      headers.certUrl &&
      headers.authAlgo,
  );
}

/**
 * The certificate must actually be PayPal's.
 *
 * `cert_url` arrives in a header, and the verification call fetches it. Passing
 * an attacker-controlled URL straight through is how that endpoint becomes a
 * way to make PayPal fetch arbitrary addresses on someone's behalf.
 */
export function isPayPalCertUrl(url: string | null | undefined): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "paypal.com" ||
        parsed.hostname.endsWith(".paypal.com"))
    );
  } catch {
    return false;
  }
}

/**
 * Asks PayPal whether it really sent this.
 *
 * Verification is a call back to PayPal rather than a local signature check,
 * because the signing certificate rotates and PayPal is the only authority on
 * which one was current. The raw body is passed through unparsed: re-serialising
 * JSON changes bytes, and changed bytes are an invalid signature.
 */
export async function verifyWebhook(
  config: PayPalConfig,
  headers: WebhookHeaders,
  rawBody: string,
): Promise<boolean> {
  if (!hasWebhookHeaders(headers)) return false;
  if (!isPayPalCertUrl(headers.certUrl)) return false;

  try {
    const token = await accessToken(config);

    const response = await fetch(
      `${apiBase(config)}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: `{"auth_algo":${JSON.stringify(headers.authAlgo)},"cert_url":${JSON.stringify(headers.certUrl)},"transmission_id":${JSON.stringify(headers.transmissionId)},"transmission_sig":${JSON.stringify(headers.transmissionSig)},"transmission_time":${JSON.stringify(headers.transmissionTime)},"webhook_id":${JSON.stringify(config.webhookId)},"webhook_event":${rawBody}}`,
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!response.ok) return false;

    const body = (await response.json()) as { verification_status?: string };
    return body.verification_status === "SUCCESS";
  } catch {
    // An unreachable verifier is not a verified webhook.
    return false;
  }
}

// ------------------------------------------------------------ event shape ---

export type FulfillableEvent = {
  /** The idempotency key: PayPal's own id for this payment or activation. */
  externalId: string;
  paypalPlanId: string;
  email: string | null;
  subscriptionId: string;
  amountCents: number | null;
  currency: string | null;
};

type PayPalEvent = {
  event_type?: string;
  resource?: Record<string, unknown>;
};

/** Events that mean money arrived and a licence is owed. */
export const FULFILLING_EVENTS = [
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "PAYMENT.SALE.COMPLETED",
] as const;

function cents(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

/**
 * Reads what a webhook is actually telling us, or null if it is not our
 * business.
 *
 * Activation covers the first period. Each renewal arrives later as its own
 * completed sale with its own id, so each one is a distinct purchase and gets
 * its own licence — which is why the idempotency key is the payment's id and
 * never the subscription's.
 */
export function parseEvent(event: unknown): FulfillableEvent | null {
  if (typeof event !== "object" || event === null) return null;

  const { event_type: type, resource } = event as PayPalEvent;
  if (!type || !resource) return null;
  if (!(FULFILLING_EVENTS as readonly string[]).includes(type)) return null;

  if (type === "BILLING.SUBSCRIPTION.ACTIVATED") {
    const id = resource.id;
    const planId = resource.plan_id;
    if (typeof id !== "string" || typeof planId !== "string") return null;

    const subscriber = resource.subscriber as
      | { email_address?: string }
      | undefined;
    const billing = resource.billing_info as
      | { last_payment?: { amount?: { value?: string; currency_code?: string } } }
      | undefined;

    return {
      externalId: id,
      paypalPlanId: planId,
      email: subscriber?.email_address ?? null,
      subscriptionId: id,
      amountCents: cents(billing?.last_payment?.amount?.value),
      currency: billing?.last_payment?.amount?.currency_code ?? null,
    };
  }

  // PAYMENT.SALE.COMPLETED — a renewal. It carries the subscription it belongs
  // to as billing_agreement_id, and nothing else ties it to a plan.
  const id = resource.id;
  const subscriptionId = resource.billing_agreement_id;
  if (typeof id !== "string" || typeof subscriptionId !== "string") return null;

  const amount = resource.amount as
    | { total?: string; currency?: string }
    | undefined;

  return {
    externalId: id,
    // Resolved from the subscription by the caller: a sale does not name a plan.
    paypalPlanId: "",
    email: null,
    subscriptionId,
    amountCents: cents(amount?.total),
    currency: amount?.currency ?? null,
  };
}

/** Fetches a subscription, to learn the plan and subscriber a renewal omits. */
export async function getSubscription(
  config: PayPalConfig,
  subscriptionId: string,
): Promise<{ planId: string; email: string | null } | null> {
  try {
    const token = await accessToken(config);

    const response = await fetch(
      `${apiBase(config)}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!response.ok) return null;

    const body = (await response.json()) as {
      plan_id?: string;
      subscriber?: { email_address?: string };
    };

    if (!body.plan_id) return null;

    return {
      planId: body.plan_id,
      email: body.subscriber?.email_address ?? null,
    };
  } catch {
    return null;
  }
}

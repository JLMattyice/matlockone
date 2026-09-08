import { afterEach, describe, expect, it } from "vitest";

import {
  apiBase,
  isPayPalCertUrl,
  hasWebhookHeaders,
  parseEvent,
  paypalConfig,
  planForPayPalId,
  planIdFor,
  type PayPalConfig,
} from "@/lib/checkout/paypal";
import {
  CHECKOUT_PROVIDER_META,
  availableCheckoutProviders,
  canSellOnline,
  isCheckoutProviderConfigured,
} from "@/lib/checkout/providers";

/**
 * The parts of the PayPal integration that can be tested without PayPal.
 *
 * The network calls cannot be — they need live credentials — so everything that
 * decides *what a payment means* is kept out of them and tested here: which
 * plan was bought, which id makes a sale unique, and what gets rejected before
 * anything is read.
 */

const config: PayPalConfig = {
  clientId: "id",
  clientSecret: "secret",
  live: false,
  webhookId: "WH-TEST",
  planIds: {
    starter_monthly: "P-STARTER-M",
    business_monthly: "P-BUSINESS-M",
    business_annual: "P-BUSINESS-A",
    pro_annual: "P-PRO-A",
  },
};

const ENV_KEYS = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
  "PAYPAL_ENV",
] as const;

const original = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("configuration", () => {
  it("is null until every credential is present", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(paypalConfig()).toBeNull();

    process.env.PAYPAL_CLIENT_ID = "id";
    process.env.PAYPAL_CLIENT_SECRET = "secret";
    // Still missing the webhook id, so verification could not work.
    expect(paypalConfig()).toBeNull();

    process.env.PAYPAL_WEBHOOK_ID = "WH-1";
    expect(paypalConfig()).not.toBeNull();
  });

  it("stays on sandbox unless explicitly told otherwise", () => {
    process.env.PAYPAL_CLIENT_ID = "id";
    process.env.PAYPAL_CLIENT_SECRET = "secret";
    process.env.PAYPAL_WEBHOOK_ID = "WH-1";

    delete process.env.PAYPAL_ENV;
    expect(apiBase(paypalConfig()!)).toContain("sandbox");

    process.env.PAYPAL_ENV = "production";
    expect(apiBase(paypalConfig()!)).toContain("sandbox");

    process.env.PAYPAL_ENV = "live";
    expect(apiBase(paypalConfig()!)).not.toContain("sandbox");
  });
});

describe("mapping plans", () => {
  it("finds the billing plan for one of ours", () => {
    expect(planIdFor(config, "business", "annual")).toBe("P-BUSINESS-A");
    expect(planIdFor(config, "starter", "monthly")).toBe("P-STARTER-M");
  });

  it("returns null for a combination that is not for sale", () => {
    expect(planIdFor(config, "pro", "monthly")).toBeNull();
    expect(planIdFor(config, "starter", "annual")).toBeNull();
  });

  it("resolves a PayPal plan id back to a plan and interval", () => {
    expect(planForPayPalId(config, "P-BUSINESS-A")).toEqual({
      plan: "business",
      interval: "annual",
    });
  });

  it("refuses a plan id it does not know", () => {
    // The alternative is trusting a payload to say what it paid for.
    expect(planForPayPalId(config, "P-SOMETHING-ELSE")).toBeNull();
    expect(planForPayPalId(config, "")).toBeNull();
  });
});

describe("reading a webhook", () => {
  const activated = {
    event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
    resource: {
      id: "I-SUB123",
      plan_id: "P-BUSINESS-A",
      subscriber: { email_address: "owner@example.com" },
      billing_info: {
        last_payment: { amount: { value: "587.64", currency_code: "USD" } },
      },
    },
  };

  const renewal = {
    event_type: "PAYMENT.SALE.COMPLETED",
    resource: {
      id: "SALE-999",
      billing_agreement_id: "I-SUB123",
      amount: { total: "587.64", currency: "USD" },
    },
  };

  it("reads an activation", () => {
    const parsed = parseEvent(activated);
    expect(parsed).toMatchObject({
      externalId: "I-SUB123",
      paypalPlanId: "P-BUSINESS-A",
      email: "owner@example.com",
      amountCents: 58_764,
      currency: "USD",
    });
  });

  it("keys a renewal on the sale, not the subscription", () => {
    // The whole reason renewals work: every period is its own payment id, so
    // each one is a distinct purchase and earns its own licence. Keying on the
    // subscription would make renewal two hand back the first licence, already
    // expired.
    const parsed = parseEvent(renewal);
    expect(parsed?.externalId).toBe("SALE-999");
    expect(parsed?.subscriptionId).toBe("I-SUB123");
    expect(parsed?.externalId).not.toBe(parsed?.subscriptionId);
  });

  it("converts money without floating point drift", () => {
    expect(parseEvent(renewal)?.amountCents).toBe(58_764);
  });

  it("ignores events that owe nobody a licence", () => {
    expect(
      parseEvent({ event_type: "BILLING.SUBSCRIPTION.CREATED", resource: { id: "x" } }),
    ).toBeNull();
    expect(
      parseEvent({ event_type: "BILLING.SUBSCRIPTION.CANCELLED", resource: { id: "x" } }),
    ).toBeNull();
  });

  it("survives anything at all in the body", () => {
    for (const junk of [null, undefined, 42, "hello", {}, { event_type: "X" }, []]) {
      expect(parseEvent(junk)).toBeNull();
    }
  });

  it("refuses an activation missing the fields it needs", () => {
    expect(
      parseEvent({
        event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
        resource: { id: "I-1" },
      }),
    ).toBeNull();
  });
});

describe("refusing an unsigned or hostile webhook", () => {
  it("requires all five signature headers", () => {
    expect(hasWebhookHeaders({})).toBe(false);
    expect(
      hasWebhookHeaders({
        transmissionId: "a",
        transmissionTime: "b",
        transmissionSig: "c",
        certUrl: "https://api.paypal.com/cert",
        authAlgo: null,
      }),
    ).toBe(false);
  });

  it("only fetches a certificate from PayPal", () => {
    // cert_url arrives in a header and gets fetched during verification.
    // Passing an arbitrary URL through is how this becomes an SSRF.
    expect(isPayPalCertUrl("https://api.paypal.com/v1/cert.pem")).toBe(true);
    expect(isPayPalCertUrl("https://api-m.sandbox.paypal.com/cert.pem")).toBe(true);

    expect(isPayPalCertUrl("http://api.paypal.com/cert.pem")).toBe(false);
    expect(isPayPalCertUrl("https://paypal.com.evil.test/cert.pem")).toBe(false);
    expect(isPayPalCertUrl("https://notpaypal.com/cert.pem")).toBe(false);
    expect(isPayPalCertUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isPayPalCertUrl("not a url")).toBe(false);
    expect(isPayPalCertUrl(null)).toBe(false);
  });
});

describe("what the deployment will offer", () => {
  it("does not offer PayPal without credentials", () => {
    for (const key of ENV_KEYS) delete process.env[key];

    expect(CHECKOUT_PROVIDER_META.PAYPAL.implemented).toBe(true);
    expect(isCheckoutProviderConfigured("PAYPAL")).toBe(false);
    expect(availableCheckoutProviders().map((p) => p.id)).not.toContain("PAYPAL");
    expect(canSellOnline()).toBe(false);
  });

  it("offers it once they are set", () => {
    process.env.PAYPAL_CLIENT_ID = "id";
    process.env.PAYPAL_CLIENT_SECRET = "secret";
    process.env.PAYPAL_WEBHOOK_ID = "WH-1";

    expect(isCheckoutProviderConfigured("PAYPAL")).toBe(true);
    expect(canSellOnline()).toBe(true);
  });

  it("never offers a provider with no adapter", () => {
    expect(CHECKOUT_PROVIDER_META.STRIPE.implemented).toBe(false);
    expect(isCheckoutProviderConfigured("STRIPE")).toBe(false);
  });
});

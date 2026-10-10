import { afterEach, describe, expect, it } from "vitest";

import {
  apiBase,
  isPayPalCertUrl,
  hasWebhookHeaders,
  paypalConfig,
  planForPayPalId,
  planIdFor,
  subscriptionIdOf,
  type PayPalConfig,
} from "@/lib/checkout/paypal";

/**
 * The parts of the PayPal integration that can be tested without PayPal.
 *
 * The network calls cannot be — they need live credentials — so everything that
 * decides *what a payment means* is kept out of them and tested here: which
 * plan was bought, which subscription a webhook is about, and what gets
 * rejected before anything is read.
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
      offer: null,
    });
  });

  it("resolves an offer's plan to the monthly plan it opens, and says which offer", () => {
    const offers = {
      ...config,
      planIds: { ...config.planIds, starter_monthly_trial: "P-STARTER-M-TRIAL", pro_monthly_launch: "P-PRO-M-LAUNCH" },
    };

    expect(planForPayPalId(offers, "P-STARTER-M-TRIAL")).toEqual({
      plan: "starter",
      interval: "monthly",
      offer: "trial",
    });
    expect(planForPayPalId(offers, "P-PRO-M-LAUNCH")).toEqual({
      plan: "pro",
      interval: "monthly",
      offer: "launch",
    });
    expect(planIdFor(offers, "starter", "monthly", "trial")).toBe("P-STARTER-M-TRIAL");
    // An offer's plan or nothing: never the full-price plan in its place.
    expect(planIdFor(offers, "business", "monthly", "trial")).toBeNull();
    expect(planIdFor(offers, "starter", "annual", "trial")).toBeNull();
  });

  it("refuses a plan id it does not know", () => {
    // The alternative is trusting a payload to say what it paid for.
    expect(planForPayPalId(config, "P-SOMETHING-ELSE")).toBeNull();
    expect(planForPayPalId(config, "")).toBeNull();
  });
});

describe("reading a webhook", () => {
  // Only the subscription's id is taken from an event. What it is worth is
  // asked of PayPal (syncSubscription), so a forged or stale body can at worst
  // make the site look something up.

  it("reads the subscription an activation, a cancellation or a failed payment is about", () => {
    for (const type of [
      "BILLING.SUBSCRIPTION.ACTIVATED",
      "BILLING.SUBSCRIPTION.CANCELLED",
      "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
    ]) {
      expect(subscriptionIdOf({ event_type: type, resource: { id: "I-SUB123" } }), type).toBe("I-SUB123");
    }
  });

  it("reads a renewal's subscription from the sale, not the sale's own id", () => {
    expect(
      subscriptionIdOf({
        event_type: "PAYMENT.SALE.COMPLETED",
        resource: { id: "SALE-999", billing_agreement_id: "I-SUB123" },
      }),
    ).toBe("I-SUB123");
  });

  it("ignores events that are not about a subscription", () => {
    expect(subscriptionIdOf({ event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "x" } })).toBeNull();
    expect(subscriptionIdOf({ event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "SALE-1" } })).toBeNull();
  });

  it("survives anything at all in the body", () => {
    for (const junk of [null, undefined, 42, "hello", {}, { event_type: "X" }, [], { event_type: "BILLING.SUBSCRIPTION.ACTIVATED" }]) {
      expect(subscriptionIdOf(junk)).toBeNull();
    }
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

/**
 * How Matlock One takes money for itself.
 *
 * Separate from `src/lib/payments`, and the distinction matters: that seam is
 * how a *customer* collects from their clients, one invoice at a time, on a
 * machine that may not be reachable from the internet. This one is how Matlock
 * sells subscriptions from a hosted site it controls. Different problem,
 * different lifecycle, and webhooks are available here precisely because the
 * hosted site has an address a processor can reach.
 *
 * The catalog carries an `implemented` flag for the same reason the payment
 * catalog does: a provider must never appear in a checkout it has no adapter
 * behind. Listing one early is how a customer gets a button that takes their
 * money and issues nothing.
 */

export const CHECKOUT_PROVIDERS = ["MANUAL", "PAYPAL", "STRIPE"] as const;
export type CheckoutProviderId = (typeof CHECKOUT_PROVIDERS)[number];

export type CheckoutProviderMeta = {
  id: CheckoutProviderId;
  label: string;
  /** False until an adapter exists AND has been exercised against the real API. */
  implemented: boolean;
  /** Why, when it is not. Shown to whoever is configuring the deployment. */
  note?: string;
};

export const CHECKOUT_PROVIDER_META: Record<
  CheckoutProviderId,
  CheckoutProviderMeta
> = {
  MANUAL: {
    id: "MANUAL",
    label: "Recorded by hand",
    implemented: true,
    note: "A sale taken any other way — an invoice, a bank transfer, a conversation. Recorded here so the licence is issued once and can be found again.",
  },
  PAYPAL: {
    id: "PAYPAL",
    label: "PayPal Subscriptions",
    implemented: true,
    note: "Needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID and a billing plan id per plan and interval. Offered only once those are set.",
  },
  STRIPE: {
    id: "STRIPE",
    label: "Stripe Billing",
    implemented: false,
    note: "Not built. Needs Stripe Billing and a webhook endpoint on the hosted site.",
  },
};

export function isCheckoutProvider(
  value: unknown,
): value is CheckoutProviderId {
  return (
    typeof value === "string" &&
    (CHECKOUT_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Whether this deployment has what a provider needs to actually take money.
 *
 * Separate from `implemented`, and both have to be true. An adapter existing in
 * the codebase says nothing about whether *this* installation has credentials:
 * a desktop copy ships the same code and must never offer to sell anything.
 *
 * Env is read here rather than through the adapters so this module stays
 * importable from anywhere, including a client bundle.
 */
export function isCheckoutProviderConfigured(id: CheckoutProviderId): boolean {
  if (!CHECKOUT_PROVIDER_META[id].implemented) return false;

  switch (id) {
    case "MANUAL":
      // Someone runs `npm run sale`. Nothing to configure.
      return true;
    case "PAYPAL":
      return Boolean(
        process.env.PAYPAL_CLIENT_ID?.trim() &&
          process.env.PAYPAL_CLIENT_SECRET?.trim() &&
          process.env.PAYPAL_WEBHOOK_ID?.trim(),
      );
    case "STRIPE":
      return false;
  }
}

/** The providers a checkout may actually offer today, on this deployment. */
export function availableCheckoutProviders(): CheckoutProviderMeta[] {
  return CHECKOUT_PROVIDERS.map((id) => CHECKOUT_PROVIDER_META[id]).filter(
    (provider) =>
      provider.implemented && isCheckoutProviderConfigured(provider.id),
  );
}

/** Whether a visitor can buy from the site at all right now. */
export function canSellOnline(): boolean {
  return availableCheckoutProviders().some(
    (provider) => provider.id !== "MANUAL",
  );
}

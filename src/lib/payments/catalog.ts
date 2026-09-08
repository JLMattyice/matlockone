/**
 * Which payment processors a business can connect, and what each one needs.
 *
 * Providers describe their own credential fields here, so the settings screen
 * renders whatever a processor asks for instead of hardcoding a form per
 * provider. Adding Stripe or Square is then a catalog entry plus an adapter,
 * with no new UI.
 *
 * Client-safe on purpose: the connect form is a client component. The code
 * that actually talks to a processor lives in ./providers, which is
 * server-only. Same split as email/catalog vs email/providers.
 */

export const PAYMENT_PROVIDERS = ["MANUAL", "PAYPAL", "STRIPE", "SQUARE"] as const;
export type PaymentProviderId = (typeof PAYMENT_PROVIDERS)[number];

export function isPaymentProvider(value: unknown): value is PaymentProviderId {
  return (
    typeof value === "string" &&
    (PAYMENT_PROVIDERS as readonly string[]).includes(value)
  );
}

export type CredentialField = {
  name: string;
  label: string;
  hint?: string;
  placeholder?: string;
  /** Encrypted at rest and never shown again. Non-secret fields are plain. */
  secret?: boolean;
  optional?: boolean;
  options?: { value: string; label: string }[];
};

export type PaymentProviderMeta = {
  label: string;
  /** What the business owner gets, in their words rather than the API's. */
  description: string;
  fields: CredentialField[];
  /**
   * Whether Matlock One can ask the processor what has been paid.
   *
   * False means the business still records payments by hand. Saying so up
   * front is better than a "check for payments" button that never finds any.
   */
  reconciles: boolean;
  /** False until the adapter ships, so the UI never offers a dead option. */
  available: boolean;
  helpUrl?: string;
};

export const PAYMENT_PROVIDER_META: Record<
  PaymentProviderId,
  PaymentProviderMeta
> = {
  MANUAL: {
    label: "My own payment link",
    description:
      "Put a link you already have on every invoice — PayPal.Me, Venmo, Cash App, a bank portal, anything with a web address. Works with any service, and needs no account setup here.",
    reconciles: false,
    available: true,
    fields: [
      {
        name: "paymentUrl",
        label: "Payment link",
        placeholder: "https://paypal.me/yourbusiness",
        hint: "Clients see this as a Pay now button on the invoice and in the email.",
      },
      {
        name: "instructions",
        label: "Instructions",
        optional: true,
        placeholder: "Please include your invoice number as the reference.",
        hint: "Shown next to the button. Useful when the link cannot carry the amount.",
      },
    ],
  },

  PAYPAL: {
    label: "PayPal",
    description:
      "Clients pay on PayPal with a card or their PayPal balance. Matlock One creates the request and asks PayPal whether it has been paid.",
    reconciles: true,
    available: true,
    helpUrl: "https://developer.paypal.com/dashboard/applications",
    fields: [
      {
        name: "environment",
        label: "Environment",
        options: [
          { value: "live", label: "Live — real money" },
          { value: "sandbox", label: "Sandbox — testing only" },
        ],
      },
      { name: "clientId", label: "Client ID", secret: true },
      { name: "clientSecret", label: "Secret", secret: true },
    ],
  },

  STRIPE: {
    label: "Stripe",
    description:
      "Clients pay by card on a Stripe-hosted page. Matlock One creates the request and asks Stripe whether it has been paid.",
    reconciles: true,
    available: false,
    helpUrl: "https://dashboard.stripe.com/apikeys",
    fields: [
      {
        name: "secretKey",
        label: "Secret key",
        secret: true,
        placeholder: "sk_live_…",
        hint: "The secret key, not the publishable one.",
      },
    ],
  },

  SQUARE: {
    label: "Square",
    description:
      "Clients pay by card on a Square-hosted page, alongside whatever you already take in person. Matlock One asks Square whether a request has been paid.",
    reconciles: true,
    available: false,
    helpUrl: "https://developer.squareup.com/apps",
    fields: [
      {
        name: "environment",
        label: "Environment",
        options: [
          { value: "production", label: "Live — real money" },
          { value: "sandbox", label: "Sandbox — testing only" },
        ],
      },
      { name: "accessToken", label: "Access token", secret: true },
      {
        name: "locationId",
        label: "Location ID",
        hint: "Which of your Square locations the money belongs to.",
      },
    ],
  },
};

export function availableProviders() {
  return PAYMENT_PROVIDERS.filter((id) => PAYMENT_PROVIDER_META[id].available);
}

/** Splits submitted values by whether they get encrypted. */
export function partitionFields(meta: PaymentProviderMeta) {
  return {
    secrets: meta.fields.filter((field) => field.secret),
    plain: meta.fields.filter((field) => !field.secret),
  };
}

import "server-only";

import type { PaymentProviderId } from "./catalog";
import { paypalAdapter } from "./paypal";

/**
 * The seam every payment processor plugs into.
 *
 * Two operations are all a processor has to offer, and they are deliberately
 * narrow:
 *
 *   createLink   — give me a web address where this invoice can be paid
 *   listPayments — tell me what has actually been paid against it
 *
 * Matlock One never takes a card number. The payment page belongs to the
 * processor, on the processor's domain, which keeps this application entirely
 * out of PCI scope and — just as importantly for the desktop build — means a
 * client at home can pay an invoice raised on a laptop that is only reachable
 * from the office network.
 *
 * Reconciliation is by polling rather than webhooks for the same reason: a
 * webhook needs an address the processor can reach, and a desktop install does
 * not have one.
 */

export type PaymentCredentials = Record<string, string>;
export type PaymentConfig = Record<string, string>;

export type PaymentRequest = {
  invoiceNumber: string;
  description: string;
  /** Always the balance outstanding, never the invoice total. */
  amountCents: number;
  currency: string;
  clientName: string;
  clientEmail: string | null;
  organizationName: string;
};

export type PaymentLink = {
  url: string;
  /** The processor's own id for this request, used later to ask about it. */
  ref: string | null;
};

/** One settled payment as the processor reports it. */
export type RemotePayment = {
  externalId: string;
  amountCents: number;
  paidAt: Date;
  reference?: string | null;
};

export type ProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type PaymentAdapter = {
  /** Confirms the credentials work, and names the account they belong to. */
  verify: (
    config: PaymentConfig,
    credentials: PaymentCredentials,
  ) => Promise<ProviderResult<{ accountLabel: string }>>;

  createLink: (
    request: PaymentRequest,
    config: PaymentConfig,
    credentials: PaymentCredentials,
  ) => Promise<ProviderResult<PaymentLink>>;

  /**
   * Everything settled against `ref`. Returning the full list rather than a
   * balance keeps this idempotent: the caller stores each payment under the
   * processor's own id, so polling twice records nothing twice.
   */
  listPayments: (
    ref: string | null,
    config: PaymentConfig,
    credentials: PaymentCredentials,
  ) => Promise<ProviderResult<RemotePayment[]>>;

  /**
   * Optional: drop anything held in memory for this processor.
   *
   * Called when saved details change. A processor that caches an access token
   * would otherwise go on using one minted under the old credentials — PayPal's
   * last nine hours — and the settings screen would appear to ignore the edit.
   */
  forget?: () => void;
};

// ------------------------------------------------------------------ manual ---

/**
 * A link the business already has — PayPal.Me, Venmo, a bank portal.
 *
 * No API and no reconciliation: the link is passed through as-is and payments
 * are still entered by hand. That is the honest trade for working with any
 * service in existence, and the catalog says so via `reconciles: false` so the
 * UI never implies otherwise.
 */
const manual: PaymentAdapter = {
  verify: async (config) => {
    const url = config.paymentUrl?.trim();
    if (!url) return { ok: false, error: "Enter the payment link." };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        ok: false,
        error: "That is not a complete web address. It should start with https://",
      };
    }

    if (parsed.protocol !== "https:") {
      return {
        ok: false,
        error:
          "Use an https:// address. Clients are being asked to send money, and browsers warn on anything else.",
      };
    }

    return { ok: true, value: { accountLabel: parsed.host } };
  },

  createLink: async (_request, config) => {
    const url = config.paymentUrl?.trim();
    if (!url) return { ok: false, error: "No payment link is configured." };

    // No per-invoice request exists at the far end, so there is no ref to
    // poll later. listPayments below is honest about that.
    return { ok: true, value: { url, ref: null } };
  },

  listPayments: async () => ({ ok: true, value: [] }),
};

// ---------------------------------------------------------------- registry ---

const ADAPTERS: Partial<Record<PaymentProviderId, PaymentAdapter>> = {
  MANUAL: manual,
  PAYPAL: paypalAdapter,
};

export function adapterFor(
  provider: PaymentProviderId,
): PaymentAdapter | null {
  return ADAPTERS[provider] ?? null;
}

/** Every adapter that exists — for disconnecting, where the provider is gone. */
export function allAdapters(): PaymentAdapter[] {
  return Object.values(ADAPTERS).filter(Boolean) as PaymentAdapter[];
}

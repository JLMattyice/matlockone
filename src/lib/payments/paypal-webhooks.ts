import "server-only";

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { resolveAppUrl, type ConfigEnv } from "../config";
import { prisma } from "../db";
import { open as openSecret } from "../secret-box";
import type { ConnectedProcessor } from "./account";
import { accessToken, call } from "./paypal";
import type { PaymentConfig, PaymentCredentials, ProviderResult } from "./providers";

/**
 * PayPal telling Matlock One that a business's invoice was paid.
 *
 * Each business connects its own PayPal app, so each needs its own webhook on
 * that app, pointing at an address that says which business it is for. The
 * address is registered for them, using their credentials, the first time it
 * can be — nobody has to find PayPal's webhook screen.
 *
 * What a notice is trusted with is deliberately small. It says *which* invoice
 * to ask about, and nothing else: the amount, the status, whether it was paid
 * at all, all come from asking PayPal directly with the business's own
 * credentials, exactly as the Check for payment button does. A forged notice
 * can therefore do no more than make Matlock One ask PayPal a question it
 * already knows how to answer. The address carries a signature as well, so
 * only an address Matlock One made gets as far as asking.
 */

/** What the webhook listens for. Partial payments arrive as PAID too. */
export const PAYPAL_NOTICE_EVENTS = [
  // An invoice paid, part-paid, or paid and pending.
  "INVOICING.INVOICE.PAID",
  // An auto-pay subscription charged.
  "PAYMENT.SALE.COMPLETED",
] as const;

/** PayPal refuses an eleventh webhook on one app. */
const WEBHOOKS_PER_APP = 10;

const TOO_MANY_WEBHOOKS = [
  "That PayPal app already has ten webhooks, which is as many as PayPal allows,",
  "so Matlock One could not add the one that reports payments.",
  "Delete one you no longer use under developer.paypal.com → Apps & Credentials → your app → Webhooks, then test the connection again.",
].join(" ");

// ---------------------------------------------------------------- address ---

const HOOK_INFO = "matlock-one:paypal-payment-notices:v1";

/**
 * The key the address is signed with, derived from ENCRYPTION_KEY.
 *
 * That key already guards the PayPal credentials themselves, so it is present
 * wherever a PayPal connection can exist. Changing it means re-entering every
 * credential anyway, and saving them registers the new address.
 */
function hookKey(env: ConfigEnv = process.env): Buffer | null {
  const secret = env.ENCRYPTION_KEY;
  if (!secret || secret.length < 32) return null;
  return Buffer.from(hkdfSync("sha256", secret, "", HOOK_INFO, 32));
}

function sign(key: Buffer, organizationId: string) {
  return createHmac("sha256", key).update(organizationId).digest("base64url").slice(0, 32);
}

/** `<business id>.<signature>` — the last part of the webhook's address. */
export function hookFor(organizationId: string, env: ConfigEnv = process.env): string | null {
  const key = hookKey(env);
  return key ? `${organizationId}.${sign(key, organizationId)}` : null;
}

/**
 * The business an address was made for, or null for one Matlock One did not
 * make. Compared in constant time, so a guess learns nothing from the timing.
 */
export function organizationForHook(
  hook: string,
  env: ConfigEnv = process.env,
): string | null {
  const match = /^([a-z0-9]{8,64})\.([A-Za-z0-9_-]{32})$/.exec(hook);
  if (!match) return null;

  const key = hookKey(env);
  if (!key) return null;

  const expected = Buffer.from(sign(key, match[1]));
  const given = Buffer.from(match[2]);
  return given.length === expected.length && timingSafeEqual(given, expected) ? match[1] : null;
}

/**
 * Where PayPal should send a business's notices, or null when there is nowhere
 * it could reach.
 *
 * PayPal only delivers to a public https address, so a desktop install or a
 * developer's laptop has none. A Vercel preview has one, but it disappears with
 * the next deploy, and registering it would leave a dead webhook on the
 * business's PayPal app — counting toward their ten — every time somebody
 * opened a preview.
 */
export function webhookAddress(
  organizationId: string,
  env: ConfigEnv = process.env,
): string | null {
  if (env.VERCEL_ENV && env.VERCEL_ENV !== "production") return null;

  const base = resolveAppUrl(env);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.startsWith("127.") ||
    url.hostname === "[::1]"
  ) {
    return null;
  }

  const hook = hookFor(organizationId, env);
  return hook ? `${base}/api/payments/paypal/webhook/${hook}` : null;
}

// ----------------------------------------------------------- registration ---

type PaypalWebhook = {
  id?: string;
  url?: string;
  event_types?: { name?: string }[];
};

/**
 * Makes sure the business's PayPal app sends its notices to `url`.
 *
 * Looks before it creates, so registering twice finds the first rather than
 * failing on PayPal's duplicate check, and an existing webhook missing an
 * event this version listens for has the list brought up to date.
 */
export async function registerPaypalWebhook(
  config: PaymentConfig,
  credentials: PaymentCredentials,
  url: string,
): Promise<ProviderResult<{ webhookId: string; created: boolean }>> {
  const token = await accessToken(config, credentials);
  if (!token.ok) return token;

  const listed = await call<{ webhooks?: PaypalWebhook[] }>(
    config,
    token.value.token,
    "/v1/notifications/webhooks",
  );
  if (!listed.ok) return listed;

  const webhooks = listed.value?.webhooks ?? [];
  const events = PAYPAL_NOTICE_EVENTS.map((name) => ({ name }));
  const existing = webhooks.find((webhook) => webhook.url === url);

  if (existing?.id) {
    const names = new Set((existing.event_types ?? []).map((event) => event.name));
    const covered = names.has("*") || PAYPAL_NOTICE_EVENTS.every((name) => names.has(name));

    if (!covered) {
      const patched = await call<PaypalWebhook>(
        config,
        token.value.token,
        `/v1/notifications/webhooks/${existing.id}`,
        { method: "PATCH", body: [{ op: "replace", path: "/event_types", value: events }] },
      );
      if (!patched.ok) return patched;
    }

    return { ok: true, value: { webhookId: existing.id, created: false } };
  }

  if (webhooks.length >= WEBHOOKS_PER_APP) return { ok: false, error: TOO_MANY_WEBHOOKS };

  const created = await call<PaypalWebhook>(
    config,
    token.value.token,
    "/v1/notifications/webhooks",
    { method: "POST", body: { url, event_types: events } },
  );
  if (!created.ok) return created;

  return { ok: true, value: { webhookId: created.value?.id ?? "", created: true } };
}

export type EnsureOutcome =
  | { ok: true; url: string }
  /** `changed`: the connection was saved again since `processor` was read. */
  | { ok: false; reason: "not-paypal" | "no-address" | "changed" }
  | { ok: false; reason: "failed"; error: string };

/**
 * Registers a PayPal business for notices unless it already is.
 *
 * The address registered is remembered in the connection's settings, so the
 * usual case costs nothing — no call to PayPal at all. Saving the connection
 * rebuilds those settings from the form, which forgets it; that is the right
 * moment to register again anyway, since the save may have been a different
 * PayPal app.
 */
export async function ensurePaypalWebhook(
  organizationId: string,
  processor: ConnectedProcessor,
): Promise<EnsureOutcome> {
  if (processor.provider !== "PAYPAL") return { ok: false, reason: "not-paypal" };

  const url = webhookAddress(organizationId);
  if (!url) return { ok: false, reason: "no-address" };
  if (processor.config.webhookUrl === url) return { ok: true, url };

  // The connection as stored now. If it no longer matches what `processor` was
  // read from, somebody has saved the form since — possibly a different PayPal
  // app — and registering on the old one would mark the new one as done.
  const before = await prisma.integration.findUnique({
    where: { organizationId_kind: { organizationId, kind: "PAYMENT" } },
    select: { provider: true, config: true, secretCipher: true, secretNonce: true, secretTag: true },
  });
  const stored = parseConfig(before?.config);
  if (
    before?.provider !== "PAYPAL" ||
    !sameSettings(stored, processor.config) ||
    !sameCredentials(before, processor.credentials)
  ) {
    return { ok: false, reason: "changed" };
  }

  const registered = await registerPaypalWebhook(processor.config, processor.credentials, url);
  if (!registered.ok) return { ok: false, reason: "failed", error: registered.error };

  // Written only over exactly what was read. A save while PayPal was being
  // asked wins, and this is redone next time against what it saved.
  await prisma.integration.updateMany({
    where: {
      organizationId,
      kind: "PAYMENT",
      config: before.config,
      secretCipher: before.secretCipher,
    },
    data: { config: JSON.stringify({ ...stored, webhookUrl: url }) },
  });

  processor.config.webhookUrl = url;
  return { ok: true, url };
}

function parseConfig(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Whether the stored secret is still the one `credentials` were opened from. */
function sameCredentials(
  sealed: { secretCipher: string | null; secretNonce: string | null; secretTag: string | null },
  credentials: PaymentCredentials,
) {
  if (!sealed.secretCipher) return false;
  const opened = openSecret({
    cipherText: sealed.secretCipher,
    nonce: sealed.secretNonce ?? undefined,
    tag: sealed.secretTag ?? undefined,
  });
  if (!opened) return false;
  try {
    const stored = JSON.parse(opened) as PaymentCredentials;
    return stored.clientId === credentials.clientId && stored.clientSecret === credentials.clientSecret;
  } catch {
    return false;
  }
}

/** The same settings, leaving aside which address was last registered. */
function sameSettings(a: Record<string, string>, b: Record<string, string>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("webhookUrl");
  return [...keys].every((key) => a[key] === b[key]);
}

/** Whether a business's PayPal notices are known to be set up. */
export function hasInstantUpdates(
  organizationId: string,
  provider: string | null | undefined,
  config: Record<string, unknown>,
): boolean {
  if (provider !== "PAYPAL") return false;
  const url = webhookAddress(organizationId);
  return Boolean(url) && config.webhookUrl === url;
}

// ----------------------------------------------------------------- notices ---

export type PaypalNotice =
  | { kind: "invoice"; paypalInvoiceId: string }
  | { kind: "subscription"; subscriptionId: string };

/**
 * Which thing a notice is about, read from the parts PayPal has been seen to
 * use. Invoicing events have carried the invoice both as the resource itself
 * and wrapped in `resource.invoice`, so both are accepted.
 */
export function noticeFrom(event: unknown): PaypalNotice | null {
  if (!event || typeof event !== "object") return null;
  const { event_type: type, resource } = event as {
    event_type?: unknown;
    resource?: Record<string, unknown> | null;
  };
  if (!resource || typeof resource !== "object") return null;

  if (type === "INVOICING.INVOICE.PAID") {
    const nested = resource.invoice as { id?: unknown } | undefined;
    const id = typeof nested?.id === "string" ? nested.id : resource.id;
    return typeof id === "string" && /^INV2-[A-Z0-9-]+$/i.test(id)
      ? { kind: "invoice", paypalInvoiceId: id }
      : null;
  }

  if (type === "PAYMENT.SALE.COMPLETED") {
    const id = resource.billing_agreement_id;
    return typeof id === "string" && /^I-[A-Z0-9]+$/i.test(id)
      ? { kind: "subscription", subscriptionId: id }
      : null;
  }

  return null;
}

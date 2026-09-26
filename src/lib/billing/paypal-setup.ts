import { annualCents, planList, type Plan } from "@/lib/checkout/plans";
import {
  FULFILLING_EVENTS,
  SUBSCRIPTION_EVENTS,
  type PayPalInterval,
} from "@/lib/checkout/paypal";
import type { LicensePlan } from "@/lib/license/token";

/**
 * Setting up PayPal to sell Matlock One: the product, a billing plan for each
 * plan and interval, and the webhook that tells us when one is paid.
 *
 * Run by hand, once per PayPal account, through `npm run paypal:setup` — never
 * by the deployment. It looks before it creates: whatever already exists under
 * the same names is reused, so running it twice makes nothing twice. A plan
 * that exists at a different price than ours stops it outright, because
 * quietly selling at the wrong price is worse than not starting.
 *
 * Everything here goes through `call`, so the tests can stand in for PayPal.
 */

export type PayPalCall = (
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) => Promise<unknown>;

export const PRODUCT_NAME = "Matlock One";

export const WEBHOOK_EVENTS: string[] = [
  ...new Set<string>([...SUBSCRIPTION_EVENTS, ...FULFILLING_EVENTS]),
];

export type PlanKey = `${LicensePlan}_${PayPalInterval}`;

const INTERVALS: PayPalInterval[] = ["monthly", "annual"];

/** Every plan we sell, in the order the env lines are printed. */
export function planSlots(): { key: PlanKey; plan: Plan; interval: PayPalInterval }[] {
  return planList().flatMap((plan) =>
    INTERVALS.map((interval) => ({ key: `${plan.id}_${interval}` as PlanKey, plan, interval })),
  );
}

/** The name the plan carries in PayPal, and on the buyer's PayPal receipt. */
export function planName(plan: Plan, interval: PayPalInterval): string {
  return `${PRODUCT_NAME} ${plan.name} (${interval === "monthly" ? "monthly" : "yearly"})`;
}

/** What one billing cycle costs, as PayPal writes money: "29.00". */
export function cyclePrice(plan: Plan, interval: PayPalInterval): string {
  const cents = interval === "monthly" ? plan.monthlyCents : annualCents(plan);
  return (cents / 100).toFixed(2);
}

export function planBody(productId: string, plan: Plan, interval: PayPalInterval) {
  return {
    product_id: productId,
    name: planName(plan, interval),
    description: `${plan.seatLabel}. Every part of ${PRODUCT_NAME}.`,
    status: "ACTIVE",
    billing_cycles: [
      {
        frequency: { interval_unit: interval === "monthly" ? "MONTH" : "YEAR", interval_count: 1 },
        tenure_type: "REGULAR",
        sequence: 1,
        // Until cancelled.
        total_cycles: 0,
        pricing_scheme: {
          fixed_price: { value: cyclePrice(plan, interval), currency_code: "USD" },
        },
      },
    ],
    payment_preferences: {
      // PayPal retries a failed payment by itself, and suspends after three
      // misses. The account's grace days run alongside those retries.
      auto_bill_outstanding: true,
      payment_failure_threshold: 3,
    },
  };
}

/** The env name each plan id goes into, matching paypalConfig(). */
export function envName(key: PlanKey): string {
  return `PAYPAL_PLAN_${key.toUpperCase()}`;
}

// ------------------------------------------------------------ looking ---

type Listed = { id: string; name?: string; status?: string; url?: string };

async function listAll(call: PayPalCall, path: string, field: string): Promise<Listed[]> {
  const found: Listed[] = [];
  // PayPal pages at 20. Ten pages is far more products or plans than this
  // account will ever have; the bound is only so a surprise cannot loop.
  for (let page = 1; page <= 10; page++) {
    const joiner = path.includes("?") ? "&" : "?";
    const body = (await call("GET", `${path}${joiner}page_size=20&page=${page}&total_required=true`)) as Record<
      string,
      unknown
    >;
    const items = (body[field] as Listed[] | undefined) ?? [];
    found.push(...items);
    const pages = Number(body.total_pages ?? 1);
    if (page >= pages || items.length === 0) break;
  }
  return found;
}

export type PlanFinding =
  | { state: "missing" }
  | { state: "ready"; id: string }
  | { state: "wrong-price"; id: string; price: string; expected: string };

export type Survey = {
  product: { id: string } | null;
  plans: Record<PlanKey, PlanFinding>;
  webhook: { id: string; events: string[]; missingEvents: string[] } | null;
};

/** What the PayPal account already has. Changes nothing. */
export async function survey(call: PayPalCall, webhookUrl: string): Promise<Survey> {
  const products = await listAll(call, "/v1/catalogs/products", "products");
  const product = products.find((p) => p.name === PRODUCT_NAME) ?? null;

  const plans = {} as Record<PlanKey, PlanFinding>;
  const existing = product
    ? (await listAll(call, `/v1/billing/plans?product_id=${encodeURIComponent(product.id)}`, "plans")).filter(
        (p) => p.status === "ACTIVE",
      )
    : [];

  for (const { key, plan, interval } of planSlots()) {
    const match = existing.find((p) => p.name === planName(plan, interval));
    if (!match) {
      plans[key] = { state: "missing" };
      continue;
    }

    // The listing leaves the price out, so each match is read in full.
    const detail = (await call("GET", `/v1/billing/plans/${encodeURIComponent(match.id)}`)) as {
      billing_cycles?: { pricing_scheme?: { fixed_price?: { value?: string } } }[];
    };
    const price = detail.billing_cycles?.[0]?.pricing_scheme?.fixed_price?.value ?? "";
    const expected = cyclePrice(plan, interval);
    plans[key] =
      Number(price) === Number(expected)
        ? { state: "ready", id: match.id }
        : { state: "wrong-price", id: match.id, price, expected };
  }

  const hooks = (
    (await call("GET", "/v1/notifications/webhooks")) as {
      webhooks?: { id: string; url: string; event_types?: { name: string }[] }[];
    }
  ).webhooks ?? [];
  const hook = hooks.find((h) => h.url === webhookUrl);
  const listening = new Set((hook?.event_types ?? []).map((e) => e.name));

  return {
    product: product ? { id: product.id } : null,
    plans,
    webhook: hook
      ? {
          id: hook.id,
          events: [...listening],
          // "*" is PayPal's every-event subscription, which already covers ours.
          missingEvents: listening.has("*") ? [] : WEBHOOK_EVENTS.filter((e) => !listening.has(e)),
        }
      : null,
  };
}

/** The lines a person reads before anything is created. */
export function describeSurvey(found: Survey, webhookUrl: string): string[] {
  const lines = [
    found.product ? `Product "${PRODUCT_NAME}": already there` : `Product "${PRODUCT_NAME}": will be created`,
  ];
  for (const { key, plan, interval } of planSlots()) {
    const finding = found.plans[key];
    const label = `Plan "${planName(plan, interval)}" at $${cyclePrice(plan, interval)}`;
    lines.push(
      finding.state === "ready"
        ? `${label}: already there`
        : finding.state === "missing"
          ? `${label}: will be created`
          : `${label}: EXISTS AT $${finding.price} INSTEAD — fix or deactivate it in PayPal first`,
    );
  }
  lines.push(
    !found.webhook
      ? `Webhook ${webhookUrl}: will be created`
      : found.webhook.missingEvents.length
        ? `Webhook ${webhookUrl}: will be given ${found.webhook.missingEvents.length} more events`
        : `Webhook ${webhookUrl}: already there`,
  );
  return lines;
}

export function hasWrongPrice(found: Survey): boolean {
  return Object.values(found.plans).some((p) => p.state === "wrong-price");
}

export function needsChanges(found: Survey): boolean {
  return (
    !found.product ||
    Object.values(found.plans).some((p) => p.state !== "ready") ||
    !found.webhook ||
    found.webhook.missingEvents.length > 0
  );
}

// ------------------------------------------------------------ creating ---

export type SetupResult = {
  productId: string;
  planIds: Record<PlanKey, string>;
  webhookId: string;
};

/**
 * Creates what the survey found missing. Refuses a survey with a plan at the
 * wrong price: that is for a person to sort out in PayPal, not for this to
 * paper over with a second plan beside it.
 */
export async function applySetup(
  call: PayPalCall,
  found: Survey,
  webhookUrl: string,
): Promise<SetupResult> {
  if (hasWrongPrice(found)) {
    throw new Error("A plan in PayPal has a different price from Matlock One's. Nothing was changed.");
  }

  const productId =
    found.product?.id ??
    ((await call("POST", "/v1/catalogs/products", {
      name: PRODUCT_NAME,
      description: "Customers, jobs, scheduling, quoting, invoicing and payments in one workspace.",
      type: "SERVICE",
      category: "SOFTWARE",
    })) as { id: string }).id;

  const planIds = {} as Record<PlanKey, string>;
  for (const { key, plan, interval } of planSlots()) {
    const finding = found.plans[key];
    planIds[key] =
      finding.state === "ready"
        ? finding.id
        : ((await call("POST", "/v1/billing/plans", planBody(productId, plan, interval))) as { id: string }).id;
  }

  let webhookId: string;
  if (!found.webhook) {
    webhookId = (
      (await call("POST", "/v1/notifications/webhooks", {
        url: webhookUrl,
        event_types: WEBHOOK_EVENTS.map((name) => ({ name })),
      })) as { id: string }
    ).id;
  } else {
    webhookId = found.webhook.id;
    if (found.webhook.missingEvents.length) {
      // Replacing the list, so it is everything it listened for before plus
      // ours — never a narrower list than it had.
      const names = [...new Set([...found.webhook.events, ...WEBHOOK_EVENTS])];
      await call("PATCH", `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`, [
        { op: "replace", path: "/event_types", value: names.map((name) => ({ name })) },
      ]);
    }
  }

  return { productId, planIds, webhookId };
}

/** The settings to paste into Vercel. The client id and secret are not
 * repeated: the person running this already has them. */
export function envLines(result: SetupResult, live: boolean): string[] {
  return [
    `PAYPAL_ENV=${live ? "live" : "sandbox"}`,
    `PAYPAL_WEBHOOK_ID=${result.webhookId}`,
    ...planSlots().map(({ key }) => `${envName(key)}=${result.planIds[key]}`),
  ];
}

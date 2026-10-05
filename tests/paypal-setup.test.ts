import { describe, expect, it } from "vitest";

import {
  applySetup,
  cyclePrice,
  describeSurvey,
  envLines,
  hasWrongPrice,
  needsChanges,
  planBody,
  planName,
  survey,
  WEBHOOK_EVENTS,
  type PayPalCall,
} from "@/lib/billing/paypal-setup";
import { PLANS } from "@/lib/checkout/plans";
import { SUBSCRIPTION_EVENTS } from "@/lib/checkout/paypal";

/**
 * The one-time PayPal setup.
 *
 * It runs against a live account with real prices, so what matters is that it
 * never makes a second of anything, never sells at a price that is not ours,
 * and never narrows what an existing webhook was listening for.
 */

const HOOK = "https://www.matlockone.com/api/checkout/paypal/webhook";

/** price is what it renews at; trial, the discounted first cycle if it has one. */
type Plan = { id: string; product_id: string; name: string; status: string; price: string; trial?: string };
type Cycle = { tenure_type: string; sequence: number; pricing_scheme: { fixed_price: { value: string } } };
type Hook = { id: string; url: string; event_types: { name: string }[] };

function fakeAccount(start: { products?: { id: string; name: string }[]; plans?: Plan[]; hooks?: Hook[] } = {}) {
  const products = [...(start.products ?? [])];
  const plans = [...(start.plans ?? [])];
  const hooks = [...(start.hooks ?? [])];
  const writes: { method: string; path: string; body: unknown }[] = [];
  let next = 1;

  const call: PayPalCall = async (method, path, body) => {
    const url = new URL(path, "https://api-m.paypal.com");
    if (method !== "GET") writes.push({ method, path: url.pathname, body });

    if (url.pathname === "/v1/catalogs/products") {
      if (method === "POST") {
        const made = { id: `PROD-${next++}`, name: (body as { name: string }).name };
        products.push(made);
        return made;
      }
      return { products, total_pages: 1 };
    }

    if (url.pathname === "/v1/billing/plans") {
      if (method === "POST") {
        const b = body as { product_id: string; name: string; billing_cycles: Cycle[] };
        const cycle = (tenure: string) =>
          b.billing_cycles.find((c) => c.tenure_type === tenure)?.pricing_scheme.fixed_price.value;
        const made: Plan = {
          id: `P-${next++}`,
          product_id: b.product_id,
          name: b.name,
          status: "ACTIVE",
          price: cycle("REGULAR")!,
          ...(cycle("TRIAL") ? { trial: cycle("TRIAL") } : {}),
        };
        plans.push(made);
        return { id: made.id };
      }
      const product = url.searchParams.get("product_id");
      return {
        plans: plans.filter((p) => p.product_id === product).map(({ price: _, ...listed }) => listed),
        total_pages: 1,
      };
    }

    const one = url.pathname.match(/^\/v1\/billing\/plans\/(.+)$/);
    if (one) {
      const found = plans.find((p) => p.id === one[1])!;
      const price = (value: string) => ({ fixed_price: { value } });
      // PayPal does not promise the cycles in order; the renewal comes first
      // here so that reading them by sequence is what is tested.
      return {
        ...found,
        billing_cycles: found.trial
          ? [
              { tenure_type: "REGULAR", sequence: 2, pricing_scheme: price(found.price) },
              { tenure_type: "TRIAL", sequence: 1, pricing_scheme: price(found.trial) },
            ]
          : [{ tenure_type: "REGULAR", sequence: 1, pricing_scheme: price(found.price) }],
      };
    }

    if (url.pathname === "/v1/notifications/webhooks") {
      if (method === "POST") {
        const b = body as { url: string; event_types: { name: string }[] };
        const made = { id: `WH-${next++}`, url: b.url, event_types: b.event_types };
        hooks.push(made);
        return made;
      }
      return { webhooks: hooks };
    }

    const hook = url.pathname.match(/^\/v1\/notifications\/webhooks\/(.+)$/);
    if (hook && method === "PATCH") {
      const found = hooks.find((h) => h.id === hook[1])!;
      found.event_types = (body as { value: { name: string }[] }[])[0].value;
      return found;
    }

    throw new Error(`Unexpected ${method} ${path}`);
  };

  return { call, products, plans, hooks, writes };
}

const run = async (account: ReturnType<typeof fakeAccount>) =>
  applySetup(account.call, await survey(account.call, HOOK), HOOK);

describe("the prices it creates", () => {
  it("are the catalog's own, with the yearly discount", () => {
    expect(cyclePrice(PLANS.starter, "monthly")).toBe("29.00");
    expect(cyclePrice(PLANS.business, "monthly")).toBe("59.00");
    // Twelve months at 17% off, rounded down to the cent.
    expect(cyclePrice(PLANS.business, "annual")).toBe("587.64");
  });
});

describe("the launch offer's plans", () => {
  it("charge half the first month, then the full monthly price until cancelled", () => {
    const body = planBody("PROD-1", PLANS.starter, "monthly", true);

    expect(body.name).toBe("Matlock One Starter (monthly, launch offer)");
    expect(body.billing_cycles).toEqual([
      expect.objectContaining({
        tenure_type: "TRIAL",
        sequence: 1,
        total_cycles: 1,
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        pricing_scheme: { fixed_price: { value: "14.50", currency_code: "USD" } },
      }),
      expect.objectContaining({
        tenure_type: "REGULAR",
        sequence: 2,
        total_cycles: 0,
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        pricing_scheme: { fixed_price: { value: "29.00", currency_code: "USD" } },
      }),
    ]);
  });

  it("leave the ordinary plans with one cycle, as before", () => {
    const body = planBody("PROD-1", PLANS.pro, "monthly");

    expect(body.name).toBe("Matlock One Pro (monthly)");
    expect(body.billing_cycles).toHaveLength(1);
    expect(body.billing_cycles[0]).toMatchObject({ tenure_type: "REGULAR", sequence: 1 });
  });
});

describe("a fresh account", () => {
  it("gets one product, nine plans and a webhook for every event we handle", async () => {
    const account = fakeAccount();

    const result = await run(account);

    expect(account.products).toHaveLength(1);
    expect(account.plans).toHaveLength(9);
    expect(account.plans.find((p) => p.name === "Matlock One Business (monthly, launch offer)")).toMatchObject({
      trial: "29.50",
      price: "59.00",
    });
    expect(account.plans.map((p) => p.name)).toContain("Matlock One Business (yearly)");
    expect(account.plans.find((p) => p.name === "Matlock One Pro (monthly)")?.price).toBe("99.00");
    expect(account.hooks).toHaveLength(1);
    expect(account.hooks[0].url).toBe(HOOK);
    expect(account.hooks[0].event_types.map((e) => e.name).sort()).toEqual([...WEBHOOK_EVENTS].sort());
    for (const event of SUBSCRIPTION_EVENTS) expect(WEBHOOK_EVENTS).toContain(event);

    expect(result.planIds.business_annual).toBe(
      account.plans.find((p) => p.name === "Matlock One Business (yearly)")?.id,
    );
  });

  it("prints the settings in the names the app reads", async () => {
    const account = fakeAccount();
    const lines = envLines(await run(account), true);

    expect(lines[0]).toBe("PAYPAL_ENV=live");
    expect(lines[1]).toBe(`PAYPAL_WEBHOOK_ID=${account.hooks[0].id}`);
    expect(lines.slice(2).map((line) => line.split("=")[0])).toEqual([
      "PAYPAL_PLAN_STARTER_MONTHLY",
      "PAYPAL_PLAN_STARTER_ANNUAL",
      "PAYPAL_PLAN_BUSINESS_MONTHLY",
      "PAYPAL_PLAN_BUSINESS_ANNUAL",
      "PAYPAL_PLAN_PRO_MONTHLY",
      "PAYPAL_PLAN_PRO_ANNUAL",
      "PAYPAL_PLAN_STARTER_MONTHLY_LAUNCH",
      "PAYPAL_PLAN_BUSINESS_MONTHLY_LAUNCH",
      "PAYPAL_PLAN_PRO_MONTHLY_LAUNCH",
    ]);
    // The secret is never printed.
    expect(lines.join("\n")).not.toMatch(/SECRET/);
  });
});

describe("running it again", () => {
  it("creates nothing a second time, and says nothing needs doing", async () => {
    const account = fakeAccount();
    const first = await run(account);
    const writes = account.writes.length;

    const found = await survey(account.call, HOOK);
    const second = await applySetup(account.call, found, HOOK);

    expect(needsChanges(found)).toBe(false);
    expect(account.writes).toHaveLength(writes);
    expect(second).toEqual(first);
    expect(describeSurvey(found, HOOK).every((line) => line.endsWith("already there"))).toBe(true);
  });

  it("adds only what is missing", async () => {
    const account = fakeAccount();
    await run(account);
    account.plans.splice(account.plans.findIndex((p) => p.name === "Matlock One Pro (yearly)"), 1);

    await run(account);

    expect(account.plans).toHaveLength(9);
    expect(account.products).toHaveLength(1);
    expect(account.hooks).toHaveLength(1);
  });

  it("does not count a deactivated plan as ours", async () => {
    const account = fakeAccount();
    await run(account);
    account.plans.find((p) => p.name === "Matlock One Starter (monthly)")!.status = "INACTIVE";

    expect((await survey(account.call, HOOK)).plans.starter_monthly).toEqual({ state: "missing" });
  });
});

describe("what it refuses", () => {
  it("stops, changing nothing, when a plan of ours exists at another price", async () => {
    const account = fakeAccount({
      products: [{ id: "PROD-OLD", name: "Matlock One" }],
      plans: [
        {
          id: "P-OLD",
          product_id: "PROD-OLD",
          name: planName(PLANS.business, "monthly"),
          status: "ACTIVE",
          price: "49.00",
        },
      ],
    });

    const found = await survey(account.call, HOOK);

    expect(hasWrongPrice(found)).toBe(true);
    expect(describeSurvey(found, HOOK).join("\n")).toContain("EXISTS AT $49.00 INSTEAD");
    await expect(applySetup(account.call, found, HOOK)).rejects.toThrow(/different price/);
    expect(account.writes).toEqual([]);
  });

  it("stops when a launch plan's first month is at another price", async () => {
    const account = fakeAccount();
    await run(account);
    account.plans.find((p) => p.name === "Matlock One Starter (monthly, launch offer)")!.trial = "9.00";
    const writes = account.writes.length;

    const found = await survey(account.call, HOOK);

    expect(found.plans.starter_monthly_launch).toMatchObject({ state: "wrong-price", price: "9.00 then $29.00" });
    expect(describeSurvey(found, HOOK).join("\n")).toContain(
      'Plan "Matlock One Starter (monthly, launch offer)" at $14.50 then $29.00: EXISTS AT $9.00 then $29.00 INSTEAD',
    );
    await expect(applySetup(account.call, found, HOOK)).rejects.toThrow(/different price/);
    expect(account.writes).toHaveLength(writes);
  });

  it("does not take a launch plan without its discounted month for one", async () => {
    // It would charge the full price to somebody who was shown half.
    const account = fakeAccount();
    await run(account);
    delete account.plans.find((p) => p.name === "Matlock One Pro (monthly, launch offer)")!.trial;

    const found = await survey(account.call, HOOK);

    expect(found.plans.pro_monthly_launch.state).toBe("wrong-price");
    expect(found.plans.pro_monthly.state).toBe("ready");
  });

  it("widens an existing webhook's events, and never narrows them", async () => {
    const account = fakeAccount({
      hooks: [{ id: "WH-OLD", url: HOOK, event_types: [{ name: "CHECKOUT.ORDER.APPROVED" }] }],
    });

    await run(account);

    expect(account.hooks).toHaveLength(1);
    const names = account.hooks[0].event_types.map((e) => e.name);
    expect(names).toContain("CHECKOUT.ORDER.APPROVED");
    for (const event of WEBHOOK_EVENTS) expect(names).toContain(event);
  });

  it("leaves alone a webhook that already hears every event", async () => {
    const account = fakeAccount({ hooks: [{ id: "WH-ALL", url: HOOK, event_types: [{ name: "*" }] }] });

    await run(account);

    expect(account.writes.some((w) => w.path.startsWith("/v1/notifications"))).toBe(false);
  });
});

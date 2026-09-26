import { describe, expect, it } from "vitest";

import {
  applySetup,
  cyclePrice,
  describeSurvey,
  envLines,
  hasWrongPrice,
  needsChanges,
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

type Plan = { id: string; product_id: string; name: string; status: string; price: string };
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
        const b = body as {
          product_id: string;
          name: string;
          billing_cycles: { pricing_scheme: { fixed_price: { value: string } } }[];
        };
        const made = {
          id: `P-${next++}`,
          product_id: b.product_id,
          name: b.name,
          status: "ACTIVE",
          price: b.billing_cycles[0].pricing_scheme.fixed_price.value,
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
      return { ...found, billing_cycles: [{ pricing_scheme: { fixed_price: { value: found.price } } }] };
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

describe("a fresh account", () => {
  it("gets one product, six plans and a webhook for every event we handle", async () => {
    const account = fakeAccount();

    const result = await run(account);

    expect(account.products).toHaveLength(1);
    expect(account.plans).toHaveLength(6);
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

    expect(account.plans).toHaveLength(6);
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

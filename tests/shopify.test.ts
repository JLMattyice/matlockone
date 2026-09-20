import { afterEach, describe, expect, it } from "vitest";

import { startFakeShopify, type FakeShopify } from "./support/shopify-server";
import {
  shopDomain,
  shopDomainProblem,
  shopifyAdapter,
} from "@/lib/payments/shopify";

/**
 * The Shopify adapter, driven over real HTTP against a stand-in speaking
 * Shopify's GraphQL shapes.
 *
 * Two things here are unlike the other processors and get the most attention:
 * Shopify reports most failures as HTTP 200 with an `errors` array, so
 * anything checking only the status code sees success; and the store domain is
 * typed by hand, where people reach for their storefront address rather than
 * the myshopify.com one the Admin API answers on.
 */

const CONFIG = { shopDomain: "northside-supply.myshopify.com" };
const CREDENTIALS = { accessToken: "shpat_fake" };

const REQUEST = {
  invoiceNumber: "INV-1102",
  description: "Ductwork cleaning",
  amountCents: 89_735,
  currency: "USD",
  clientName: "Desmond Achterberg",
  clientEmail: "desmond@example.test",
  organizationName: "Matlock Field Services",
  payPageUrl: "https://app.example.test/share/invoice/tok_test/pay",
};

let shopify: FakeShopify | undefined;

async function start(options: Parameters<typeof startFakeShopify>[0] = {}) {
  shopify = await startFakeShopify(options);
  process.env.SHOPIFY_API_BASE = shopify.baseUrl;
}

afterEach(async () => {
  delete process.env.SHOPIFY_API_BASE;

  const running = shopify;
  shopify = undefined;
  await running?.close();
});

function fake(): FakeShopify {
  if (!shopify) throw new Error("no fake Shopify running — call start() first");
  return shopify;
}

describe("the store domain", () => {
  it("tidies what people actually paste", () => {
    expect(shopDomain({ shopDomain: "https://Northside-Supply.myshopify.com/admin" })).toBe(
      "northside-supply.myshopify.com",
    );
    expect(shopDomain({ shopDomain: "  northside-supply.myshopify.com  " })).toBe(
      "northside-supply.myshopify.com",
    );
  });

  it("refuses a storefront domain, and says which address is wanted", () => {
    // The Admin API answers on myshopify.com only, and a storefront domain
    // fails as a connection error that explains nothing.
    const problem = shopDomainProblem("northsidesupply.com");

    expect(problem).toMatch(/myshopify\.com/);
    expect(problem).toMatch(/storefront domain/i);
  });

  it("accepts a proper admin domain", () => {
    expect(shopDomainProblem("northside-supply.myshopify.com")).toBeNull();
  });
});

describe("verify", () => {
  it("names the store", async () => {
    await start();

    const result = await shopifyAdapter.verify(CONFIG, CREDENTIALS);

    expect(result).toEqual({
      ok: true,
      value: { accountLabel: "Northside Supply (Shopify)" },
    });
  });

  it("checks the token can see draft orders, not merely that it works", async () => {
    // A token with only read_products would otherwise connect happily and
    // fail on the first invoice.
    await start();
    await shopifyAdapter.verify(CONFIG, CREDENTIALS);

    expect(fake().requests[0].query).toContain("draftOrders");
  });

  it("refuses a storefront domain before calling out", async () => {
    await start();

    const result = await shopifyAdapter.verify(
      { shopDomain: "northsidesupply.com" },
      CREDENTIALS,
    );

    expect(result.ok).toBe(false);
    expect(fake().requests).toHaveLength(0);
  });

  it("explains a rejected token", async () => {
    await start();

    const result = await shopifyAdapter.verify(CONFIG, { accessToken: "shpat_wrong" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/rejected that access token/i);
  });

  it("names the scopes when Shopify says access denied", async () => {
    await start({ graphqlError: { message: "Access denied for draftOrders field" } });

    const result = await shopifyAdapter.verify(CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /write_draft_orders and read_orders/,
    );
  });

  it("treats a 200 carrying an errors array as the failure it is", async () => {
    // The trap in this API: the status code says success.
    await start({ graphqlError: { message: "Something was wrong with the query" } });

    const result = await shopifyAdapter.verify(CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(
      "Something was wrong with the query",
    );
  });

  it("reports throttling as something to wait out", async () => {
    await start({
      graphqlError: { message: "Throttled", code: "THROTTLED" },
    });

    const result = await shopifyAdapter.verify(CONFIG, CREDENTIALS);

    expect(result.ok === false && result.error).toMatch(/rate limiting/i);
  });
});

describe("createLink", () => {
  it("returns the Shopify checkout and the draft order id", async () => {
    await start();

    const result = await shopifyAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.url).toMatch(/\/invoices\/\d+$/);
    expect(result.value.ref).toMatch(/^gid:\/\/shopify\/DraftOrder\//);
  });

  it("bills the balance as one custom line, needing nothing in the catalog", async () => {
    // The business sells work, not products Shopify knows about.
    await start();
    await shopifyAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const input = fake().requests[0].variables.input as {
      lineItems?: { title?: string; originalUnitPrice?: string; quantity?: number }[];
    };

    expect(input.lineItems?.[0].originalUnitPrice).toBe("897.35");
    expect(input.lineItems?.[0].quantity).toBe(1);
    expect(input.lineItems?.[0].title).toContain("INV-1102");
  });

  it("does not let Shopify tax a total that is already taxed", async () => {
    // Our line is the taxed total from our own document. Shopify applying the
    // store's tax settings on top would bill the client twice for it.
    await start();
    await shopifyAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const input = fake().requests[0].variables.input as {
      taxExempt?: boolean;
      lineItems?: { taxable?: boolean }[];
    };

    expect(input.taxExempt).toBe(true);
    expect(input.lineItems?.[0].taxable).toBe(false);
  });

  it("never asks Shopify to email the invoice", async () => {
    await start();
    await shopifyAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    // draftOrderInvoiceSend is how Shopify emails one. Matlock One sends the
    // document, and two senders for one debt is how a client pays twice.
    expect(
      fake().requests.some((r) => r.query.includes("draftOrderInvoiceSend")),
    ).toBe(false);
  });

  it("passes a userError back in Shopify's own words", async () => {
    await start({ userError: "Line item price must be greater than or equal to 0" });

    const result = await shopifyAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /Line item price must be greater/,
    );
  });

  it("reports a draft that came back with no checkout link", async () => {
    await start({ withoutInvoiceUrl: true });

    const result = await shopifyAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no checkout link/i);
  });
});

describe("listPayments", () => {
  it("reports nothing while the draft is still a draft", async () => {
    await start();
    const link = await shopifyAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    const result = await shopifyAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    // Nobody has been through the checkout yet. Not a failure.
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("reports the order under its own id, so polling twice is safe", async () => {
    await start();
    const link = await shopifyAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    fake().pay(link.value.ref!, "gid://shopify/Order/9001");

    const first = await shopifyAdapter.listPayments(link.value.ref, CONFIG, CREDENTIALS);
    const second = await shopifyAdapter.listPayments(link.value.ref, CONFIG, CREDENTIALS);

    expect(first.ok && first.value).toHaveLength(1);
    expect(first.ok && first.value[0]).toMatchObject({
      externalId: "gid://shopify/Order/9001",
      amountCents: 89_735,
    });
    // A draft becomes exactly one order, so the id never moves.
    expect(second.ok && second.value[0].externalId).toBe("gid://shopify/Order/9001");
  });

  it("refuses to poll an invoice that never had a link", async () => {
    await start();

    const result = await shopifyAdapter.listPayments(null, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(fake().requests).toHaveLength(0);
  });

  it("explains a draft order Shopify no longer has", async () => {
    await start();

    const result = await shopifyAdapter.listPayments(
      "gid://shopify/DraftOrder/404",
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no longer has that draft order/i);
  });
});

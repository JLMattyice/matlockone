import { afterEach, describe, expect, it } from "vitest";

import { startFakeStripe, type FakeStripe } from "./support/stripe-server";
import { settlementId, stripeAdapter } from "@/lib/payments/stripe";

/**
 * The Stripe adapter, driven over real HTTP against a stand-in that speaks
 * Stripe's documented shapes.
 *
 * These prove the adapter handles those shapes correctly. They cannot prove
 * Stripe's live API matches them — only a test-mode key against the real API
 * does that.
 */

const CONFIG = {};
const CREDENTIALS = { secretKey: "sk_test_fake" };

const REQUEST = {
  invoiceNumber: "INV-1102",
  description: "Ductwork cleaning",
  amountCents: 89_735,
  currency: "USD",
  clientName: "Desmond Achterberg",
  clientEmail: "desmond@example.test",
  organizationName: "Matlock Field Services",
};

let stripe: FakeStripe | undefined;

async function start(options: Parameters<typeof startFakeStripe>[0] = {}) {
  stripe = await startFakeStripe(options);
  process.env.STRIPE_API_BASE = stripe.baseUrl;
}

afterEach(async () => {
  delete process.env.STRIPE_API_BASE;

  // Cleared before closing, so a test that starts no server does not try to
  // close the previous one a second time.
  const running = stripe;
  stripe = undefined;
  await running?.close();
});

/** The fake, for a test that has started one. */
function fake(): FakeStripe {
  if (!stripe) throw new Error("no fake Stripe running — call start() first");
  return stripe;
}

describe("verify", () => {
  it("names the account and the mode the key belongs to", async () => {
    await start();

    const result = await stripeAdapter.verify(CONFIG, CREDENTIALS);

    expect(result).toEqual({
      ok: true,
      value: { accountLabel: "Northside Home Services (test mode)" },
    });
  });

  it("probes the API it actually uses, not just the account", async () => {
    await start();
    await stripeAdapter.verify(CONFIG, CREDENTIALS);

    // A key that can read the account but cannot write invoices is no use
    // here, so invoices are what gets tested.
    expect(fake().requests[0].path).toBe("/v1/invoices?limit=1");
  });

  it("accepts a restricted key that cannot read the account", async () => {
    // Refusing this would turn away a key that can do everything the adapter
    // needs, purely because it could not supply a display name.
    await start({ noAccountAccess: true });

    const result = await stripeAdapter.verify(CONFIG, CREDENTIALS);

    expect(result).toEqual({
      ok: true,
      value: { accountLabel: "Stripe (test mode)" },
    });
  });

  it("says a live key is live, so the mode is never a guess", async () => {
    await start({ secretKey: "sk_live_fake", noAccountAccess: true });

    const result = await stripeAdapter.verify(CONFIG, {
      secretKey: "sk_live_fake",
    });

    expect(result).toEqual({ ok: true, value: { accountLabel: "Stripe (live)" } });
  });

  it("explains a rejected key in terms of the mode it came from", async () => {
    await start();

    const result = await stripeAdapter.verify(CONFIG, {
      secretKey: "sk_test_wrong",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /rejected that secret key.*test-mode key/is,
    );
  });

  it("refuses to call out at all when the key is blank", async () => {
    await start();

    const result = await stripeAdapter.verify(CONFIG, { secretKey: "" });

    expect(result.ok).toBe(false);
    expect(fake().requests).toHaveLength(0);
  });
});

describe("createLink", () => {
  it("returns the hosted invoice page and the invoice id", async () => {
    await start();

    const result = await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.url).toMatch(/^https:\/\/invoice\.stripe\.test\/i\/in_/);
    expect(result.value.ref).toMatch(/^in_/);
  });

  it("sends form-encoded bodies, which is the only shape Stripe reads", async () => {
    await start();
    await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const posts = fake().requests.filter((r) => r.method === "POST");
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      expect(post.contentType).toBe("application/x-www-form-urlencoded");
    }
  });

  it("bills the outstanding balance, in the smallest currency unit", async () => {
    await start();
    await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const item = fake().requests.find((r) => r.path.startsWith("/v1/invoiceitems"));
    expect(item?.form.amount).toBe("89735");
    expect(item?.form.currency).toBe("usd");
    expect(item?.form.description).toBe("Ductwork cleaning");
  });

  it("carries our invoice number, so a Stripe row can be traced back", async () => {
    await start();
    await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const created = fake().requests.find(
      (r) => r.method === "POST" && r.path === "/v1/invoices",
    );
    expect(created?.form["metadata[matlock_invoice]"]).toBe("INV-1102");
    expect(created?.form.description).toContain("INV-1102");
  });

  it("never lets Stripe chase or email the invoice itself", async () => {
    // Matlock One sends the document. Two invoices from two senders for the
    // same money is how a client pays twice.
    await start();
    await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const created = fake().requests.find(
      (r) => r.method === "POST" && r.path === "/v1/invoices",
    );
    expect(created?.form.auto_advance).toBe("false");
    expect(created?.form.collection_method).toBe("send_invoice");

    expect(fake().requests.some((r) => r.path.includes("/send"))).toBe(false);
  });

  it("sends an idempotency key, so a double-click cannot bill twice", async () => {
    await start();
    await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const created = fake().requests.find(
      (r) => r.method === "POST" && r.path === "/v1/invoices",
    );
    expect(created?.idempotencyKey).toBe("matlock-inv-INV-1102-89735");
  });

  it("reuses an existing customer with the same email", async () => {
    await start({
      existingCustomer: { id: "cus_existing", email: "desmond@example.test" },
    });

    await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    // A dashboard with one customer per invoice is unusable for the business.
    expect(
      fake().requests.some((r) => r.method === "POST" && r.path === "/v1/customers"),
    ).toBe(false);

    const created = fake().requests.find(
      (r) => r.method === "POST" && r.path === "/v1/invoices",
    );
    expect(created?.form.customer).toBe("cus_existing");
  });

  it("creates a customer when the client has no email to match on", async () => {
    await start();

    const result = await stripeAdapter.createLink(
      { ...REQUEST, clientEmail: null },
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok).toBe(true);
    expect(
      fake().requests.some((r) => r.method === "POST" && r.path === "/v1/customers"),
    ).toBe(true);
    // Nothing to search by, so no lookup should have been attempted.
    expect(
      fake().requests.some((r) => r.method === "GET" && r.path.includes("email=")),
    ).toBe(false);
  });

  it("attaches the line to the invoice it just made, not to a pending pile", async () => {
    await start();
    const result = await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = fake().requests.find((r) => r.path.startsWith("/v1/invoiceitems"));
    expect(item?.form.invoice).toBe(result.value.ref);
  });

  it("finalizes, because a draft has no payable page", async () => {
    await start();
    await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(
      fake().requests.some((r) => r.path.includes("/finalize_invoice")),
    ).toBe(true);
  });

  it("reports a finalized invoice that came back without a page", async () => {
    await start({ withoutHostedUrl: true });

    const result = await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no payment page/i);
  });

  it("passes a refusal back in Stripe's own words", async () => {
    await start({
      failWith: {
        status: 400,
        path: "/v1/invoices",
        body: { error: { message: "Invalid currency: zzz" } },
      },
    });

    const result = await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("Invalid currency: zzz");
  });

  it("names the missing permission when a restricted key cannot write", async () => {
    await start({ failWith: { status: 403, path: "/v1/customers" } });

    const result = await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /restricted key needs write access to Invoices and Customers/i,
    );
  });
});

describe("listPayments", () => {
  it("reports nothing before the invoice is paid", async () => {
    await start();
    const link = await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    const result = await stripeAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    // Unpaid is an answer, not a failure.
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("reports the settlement under Stripe's own id, so polling twice is safe", async () => {
    await start();
    const link = await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    fake().pay(link.value.ref!, 89_735, "pi_abc123");

    const first = await stripeAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );
    const second = await stripeAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    expect(first.ok && first.value).toHaveLength(1);
    expect(first.ok && first.value[0]).toMatchObject({
      externalId: "pi_abc123",
      amountCents: 89_735,
    });
    // The same id both times is what stops a second poll recording a second
    // payment against the invoice.
    expect(second.ok && second.value[0].externalId).toBe("pi_abc123");
  });

  it("dates the payment from Stripe's own timestamp", async () => {
    await start();
    const link = await stripeAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    fake().pay(link.value.ref!, 89_735, "pi_abc123");

    const result = await stripeAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Unix seconds, not milliseconds — reading it wrong dates payments in 1970.
    const paidAt = result.value[0].paidAt;
    expect(paidAt.getFullYear()).toBe(new Date().getFullYear());
  });

  it("refuses to poll an invoice that never had a link", async () => {
    await start();

    const result = await stripeAdapter.listPayments(null, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(fake().requests).toHaveLength(0);
  });

  it("explains an invoice Stripe no longer has", async () => {
    await start();

    const result = await stripeAdapter.listPayments(
      "in_deleted",
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no longer has that invoice/i);
  });
});

describe("settlementId", () => {
  it("reads the id whichever shape the API version returns", () => {
    expect(settlementId({ id: "in_1", payment_intent: "pi_1" })).toBe("pi_1");
    expect(settlementId({ id: "in_1", payment_intent: { id: "pi_2" } })).toBe(
      "pi_2",
    );
  });

  it("falls back to the invoice, which settles once", () => {
    // A restricted key may not be allowed to read the payment intent at all.
    // The fallback still has to be stable across polls.
    expect(settlementId({ id: "in_1", payment_intent: null })).toBe("in_1:paid");
    expect(settlementId({})).toBeNull();
  });
});

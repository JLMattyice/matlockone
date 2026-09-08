import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakePaypal, type FakePaypal } from "./support/paypal-server";
import {
  forgetPaypalToken,
  invoiceIdFrom,
  paypalAdapter,
} from "@/lib/payments/paypal";

/**
 * The PayPal adapter, driven over real HTTP against a stand-in that speaks
 * PayPal's documented shapes.
 *
 * These prove the adapter handles those shapes correctly. They cannot prove
 * PayPal's live API matches them — only a sandbox account does that.
 */

const CONFIG = { environment: "sandbox" };
const CREDENTIALS = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
};

const REQUEST = {
  invoiceNumber: "INV-1102",
  description: "Ductwork cleaning",
  amountCents: 89_735,
  currency: "USD",
  clientName: "Desmond Achterberg",
  clientEmail: "desmond@example.test",
  organizationName: "Matlock Field Services",
};

let paypal: FakePaypal;

async function start(options: Parameters<typeof startFakePaypal>[0] = {}) {
  paypal = await startFakePaypal(options);
  process.env.PAYPAL_API_BASE = paypal.baseUrl;
  // The adapter caches tokens per credential; a fresh server must not inherit
  // a token minted against the previous one.
  forgetPaypalToken(CREDENTIALS.clientId);
}

afterEach(async () => {
  delete process.env.PAYPAL_API_BASE;
  forgetPaypalToken(CREDENTIALS.clientId);
  await paypal?.close();
});

describe("verify", () => {
  beforeEach(() => start());

  it("confirms working credentials and names the environment", async () => {
    const result = await paypalAdapter.verify(CONFIG, CREDENTIALS);

    expect(result).toEqual({
      ok: true,
      value: { accountLabel: "PayPal (sandbox)" },
    });
  });

  it("checks the invoicing scope, not just that a token was issued", async () => {
    await paypalAdapter.verify(CONFIG, CREDENTIALS);

    const paths = paypal.requests.map((request) => request.path);
    expect(paths[0]).toContain("/v1/oauth2/token");
    // A token that cannot reach Invoicing is not a working connection.
    expect(paths.some((path) => path.startsWith("/v2/invoicing/invoices?"))).toBe(
      true,
    );
  });

  it("explains a wrong client ID or secret in the user's terms", async () => {
    const result = await paypalAdapter.verify(CONFIG, {
      clientId: "wrong",
      clientSecret: "wrong",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /rejected those credentials.*sandbox key will not work against live/is,
    );
  });

  it("refuses to call out at all when a credential is blank", async () => {
    const result = await paypalAdapter.verify(CONFIG, {
      clientId: "",
      clientSecret: "x",
    });

    expect(result.ok).toBe(false);
    expect(paypal.requests).toHaveLength(0);
  });
});

describe("createLink", () => {
  beforeEach(() => start());

  it("creates, publishes and returns a payable link", async () => {
    const result = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.url).toMatch(/^https:\/\/www\.paypal\.com\/invoice\/p\//);
    expect(result.value.ref).toBe("INV2-TEST-1");

    // Created, then sent. An unsent PayPal invoice is not payable.
    const posts = paypal.requests.filter((r) => r.method === "POST");
    expect(posts.map((r) => r.path)).toEqual([
      "/v1/oauth2/token",
      "/v2/invoicing/invoices",
      "/v2/invoicing/invoices/INV2-TEST-1/send",
    ]);
  });

  it("bills the outstanding balance as a decimal amount", async () => {
    await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const create = paypal.requests.find(
      (r) => r.method === "POST" && r.path === "/v2/invoicing/invoices",
    );
    const body = create?.body as {
      items: { unit_amount: { value: string; currency_code: string } }[];
      detail: { currency_code: string; reference: string };
    };

    // 89735 cents must reach PayPal as "897.35", not 89735 or 897.3500000001.
    expect(body.items[0].unit_amount.value).toBe("897.35");
    expect(body.items[0].unit_amount.currency_code).toBe("USD");
    expect(body.detail.currency_code).toBe("USD");
    expect(body.detail.reference).toBe("INV-1102");
  });

  it("does not let PayPal email its own copy of the invoice", async () => {
    await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const send = paypal.requests.find((r) => r.path.endsWith("/send"));
    // Fieldbase sends the email. Two invoices from two senders for the same
    // money is how a client ends up paying twice.
    expect(send?.body).toEqual({ send_to_recipient: false });
  });

  it("sends an idempotency key so a double click cannot bill twice", async () => {
    const first = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    const second = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const create = paypal.requests.find(
      (r) => r.method === "POST" && r.path === "/v2/invoicing/invoices",
    );
    expect(create?.requestId).toBe("worksuite-INV-1102-89735");

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.ref).toBe(first.value.ref);
    expect(paypal.invoices.size).toBe(1);
  });

  it("re-reads the invoice when the send response carries no link", async () => {
    await paypal.close();
    await start({ linkOnlyOnReread: true });

    const result = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.url).toContain("/invoice/p/");
  });

  it("names the client as recipient when there is an email", async () => {
    await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const create = paypal.requests.find(
      (r) => r.method === "POST" && r.path === "/v2/invoicing/invoices",
    );
    const body = create?.body as {
      primary_recipients?: { billing_info: { email_address: string } }[];
    };

    expect(body.primary_recipients?.[0].billing_info.email_address).toBe(
      "desmond@example.test",
    );
  });

  it("still creates a link for a client with no email on file", async () => {
    const result = await paypalAdapter.createLink(
      { ...REQUEST, clientEmail: null },
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok).toBe(true);

    const create = paypal.requests.find(
      (r) => r.method === "POST" && r.path === "/v2/invoicing/invoices",
    );
    expect((create?.body as Record<string, unknown>).primary_recipients).toBeUndefined();
  });
});

describe("listPayments", () => {
  beforeEach(() => start());

  it("reports nothing before the client has paid", async () => {
    const link = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    const result = await paypalAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("converts a settled payment back to exact cents", async () => {
    const link = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    paypal.pay(link.value.ref!, "897.35", "PAY-CAPTURE-1");

    const result = await paypalAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    expect(result.value[0].amountCents).toBe(89_735);
    expect(result.value[0].externalId).toBe("PAY-CAPTURE-1");
    expect(result.value[0].paidAt.toISOString()).toContain("2026-08-30");
  });

  it("rounds rather than truncates, on the amounts where it matters", async () => {
    const link = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    // In binary floating point 0.29 * 100 is 28.999999999999996 and
    // 4.35 * 100 is 434.99999999999994. Truncating either loses a cent, and
    // an invoice that never quite settles is a support call every time.
    paypal.pay(link.value.ref!, "0.29", "PAY-A");
    paypal.pay(link.value.ref!, "4.35", "PAY-B");
    paypal.pay(link.value.ref!, "1.15", "PAY-C");

    const result = await paypalAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok && result.value.map((p) => p.amountCents)).toEqual([
      29, 435, 115,
    ]);
  });

  it("returns every payment, so a part-payment history reconciles", async () => {
    const link = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    paypal.pay(link.value.ref!, "400.00", "PAY-1");
    paypal.pay(link.value.ref!, "497.35", "PAY-2");

    const result = await paypalAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok && result.value.map((p) => p.amountCents)).toEqual([
      40_000, 49_735,
    ]);
  });

  it("skips a transaction with no id rather than recording it every poll", async () => {
    const link = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    const invoice = paypal.invoices.get(link.value.ref!)!;
    invoice.payments.transactions.push({
      payment_id: "",
      amount: { value: "50.00", currency_code: "USD" },
      payment_date: "2026-08-30",
      method: "PAYPAL",
    });

    const result = await paypalAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    // Nothing to deduplicate on means it would be re-recorded forever.
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("says so plainly when the invoice has no PayPal request", async () => {
    const result = await paypalAdapter.listPayments(null, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no PayPal request/i);
  });
});

/**
 * The Invoicing feature.
 *
 * This is the first thing a real PayPal app gets wrong: the feature is granted
 * per app, in the developer dashboard, and until it is ticked every Invoicing
 * call is refused. All of these come from meeting it against the live API.
 */
describe("the Invoicing permission", () => {
  const INVOICING = "https://uri.paypal.com/services/invoicing";

  it("names the problem from the token alone, before making a call", async () => {
    await start({ scopes: ["https://uri.paypal.com/services/payments/payment"] });

    const result = await paypalAdapter.verify(CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/tick Invoicing under Features/i);
    // PayPal says outright what the app may do. Reading it means the diagnosis
    // is certain, rather than inferred from a 403 with several causes.
    expect(paypal.requests.some((r) => r.path.startsWith("/v2/invoicing"))).toBe(false);
  });

  it("does not invent a failure when no scope list comes back", async () => {
    // An empty list is a response shape, not a permission. Treating it as one
    // would break every working connection the day PayPal changed the field.
    await start({ scopes: [] });

    const result = await paypalAdapter.verify(CONFIG, CREDENTIALS);

    expect(result.ok).toBe(true);
  });

  it("still checks with a real call when the scope looks right", async () => {
    // The app may invoice; the account behind it may not. A Personal account
    // carries the scope and is refused all the same.
    await start({
      scopes: [INVOICING],
      failWith: {
        status: 403,
        path: "/v2/invoicing",
        body: { name: "NOT_AUTHORIZED", message: "Merchant not enabled for invoicing" },
      },
    });

    const result = await paypalAdapter.verify(CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Merchant not enabled/i);
  });

  it("asks for a new token every time it is tested", async () => {
    await start();

    await paypalAdapter.verify(CONFIG, CREDENTIALS);
    await paypalAdapter.verify(CONFIG, CREDENTIALS);

    // "Test" is pressed straight after ticking Invoicing at PayPal. A cached
    // token was minted under the old permissions and lasts nine hours, so
    // reusing it would report the same failure and make a fix that worked look
    // as though it had not.
    expect(paypal.tokenGrants()).toBe(2);
  });

  it("reuses the token for ordinary work", async () => {
    await start();

    await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    await paypalAdapter.createLink(
      { ...REQUEST, invoiceNumber: "INV-1103" },
      CONFIG,
      CREDENTIALS,
    );

    // Only verify pays the cost. Every invoice fetching its own token would be
    // a pointless round trip on a connection that is already known to work.
    expect(paypal.tokenGrants()).toBe(1);
  });

  it("forgets the cached token when the details change", async () => {
    await start();
    await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    expect(paypal.tokenGrants()).toBe(1);

    // What the settings screen calls after saving. Without it, correcting a
    // secret would appear to change nothing for the rest of the day.
    paypalAdapter.forget?.();
    await paypalAdapter.createLink(
      { ...REQUEST, invoiceNumber: "INV-1104" },
      CONFIG,
      CREDENTIALS,
    );

    expect(paypal.tokenGrants()).toBe(2);
  });
});

describe("failure handling", () => {
  it("explains a missing Invoicing permission", async () => {
    await start({
      failWith: { status: 403, path: "/v2/invoicing", body: { name: "NOT_AUTHORIZED" } },
    });

    const result = await paypalAdapter.verify(CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/tick Invoicing under Features/i);
  });

  it("keeps PayPal's own words on a refusal that is not about Invoicing", async () => {
    await start({
      failWith: {
        status: 403,
        path: "/v2/invoicing",
        body: {
          name: "RESOURCE_NOT_ACCESSIBLE",
          details: [{ issue: "INVALID_RESOURCE_ID", description: "Invoice belongs to another merchant" }],
        },
      },
    });

    const result = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    // Reporting every 403 as a missing feature sent people into the developer
    // dashboard to fix something that was never broken.
    expect(result.ok === false && result.error).toMatch(/another merchant/i);
    expect(result.ok === false && result.error).not.toMatch(/tick Invoicing/i);
  });

  it("explains a duplicate invoice number", async () => {
    await start({
      failWith: {
        status: 422,
        path: "/v2/invoicing/invoices",
        body: {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "DUPLICATE_INVOICE_NUMBER" }],
        },
      },
    });

    const result = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/already has an invoice/i);
  });

  it("does not blame the user for an outage at PayPal", async () => {
    await start({
      failWith: { status: 500, path: "/v2/invoicing" },
    });

    const result = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/their end/i);
  });

  it("passes through a specific PayPal complaint when there is one", async () => {
    await start({
      failWith: {
        status: 400,
        path: "/v2/invoicing/invoices",
        body: {
          name: "INVALID_REQUEST",
          details: [
            { issue: "INVALID_CURRENCY_CODE", description: "Currency ZZZ is not supported." },
          ],
        },
      },
    });

    const result = await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok === false && result.error).toBe(
      "Currency ZZZ is not supported.",
    );
  });

  it("reports an unreachable PayPal rather than hanging", async () => {
    await start();
    const dead = paypal.baseUrl;
    await paypal.close();
    process.env.PAYPAL_API_BASE = dead;
    forgetPaypalToken(CREDENTIALS.clientId);

    const result = await paypalAdapter.verify(CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /could not reach paypal|internet connection/i,
    );
  });
});

describe("token handling", () => {
  beforeEach(() => start());

  it("reuses the access token instead of re-authenticating on every call", async () => {
    await paypalAdapter.verify(CONFIG, CREDENTIALS);
    await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    await paypalAdapter.listPayments("INV2-TEST-1", CONFIG, CREDENTIALS);

    const tokenCalls = paypal.requests.filter((r) =>
      r.path.startsWith("/v1/oauth2/token"),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("never puts the secret anywhere but the auth header", async () => {
    await paypalAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    for (const request of paypal.requests) {
      if (request.path.startsWith("/v1/oauth2/token")) continue;
      expect(JSON.stringify(request.body ?? "")).not.toContain(
        CREDENTIALS.clientSecret,
      );
    }
  });
});

/**
 * Finding the invoice PayPal just made.
 *
 * Creating an invoice does not answer with an id. It answers with a link to the
 * new invoice, and the id is the last segment of it. Reading only `id` meant
 * every create looked like a failure: the invoice was never published, no
 * payable link came back, and a dangling draft was left in the merchant's
 * PayPal account each time somebody tried.
 *
 * The local fake used to return an id, so it agreed with the mistake and the
 * suite stayed green while the live integration could not create a single
 * payable invoice.
 */
describe("reading the new invoice's id", () => {
  it("takes it from the link PayPal actually returns", () => {
    expect(
      invoiceIdFrom({
        href: "https://api-m.paypal.com/v2/invoicing/invoices/INV2-YKBA-4W69-SXWV-W823",
      }),
    ).toBe("INV2-YKBA-4W69-SXWV-W823");
  });

  it("takes it from a self link when that is the shape", () => {
    expect(
      invoiceIdFrom({
        links: [
          { rel: "self", href: "https://api-m.paypal.com/v2/invoicing/invoices/INV2-ABCD-1234" },
        ],
      }),
    ).toBe("INV2-ABCD-1234");
  });

  it("still accepts a plain id, in case they ever send one", () => {
    expect(invoiceIdFrom({ id: "INV2-PLAIN-0001" })).toBe("INV2-PLAIN-0001");
  });

  it("ignores a query string on the link", () => {
    expect(
      invoiceIdFrom({ href: "https://api-m.paypal.com/v2/invoicing/invoices/INV2-Q-1?x=1" }),
    ).toBe("INV2-Q-1");
  });

  it("gives up rather than inventing one", () => {
    // Better to report that PayPal said something unexpected than to publish
    // a request against an id that does not exist.
    expect(invoiceIdFrom(null)).toBeNull();
    expect(invoiceIdFrom({})).toBeNull();
    // A payer-view link points at the customer-facing page, not at the
    // invoice resource. Reading an id off it would build API calls against
    // something that is not an invoice id at all.
    expect(invoiceIdFrom({ links: [{ rel: "payer-view", href: "https://x/y" }] })).toBeNull();
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { startFakeSquare, type FakeSquare } from "./support/square-server";
import { squareAdapter } from "@/lib/payments/square";

/**
 * The Square adapter, driven over real HTTP against a stand-in speaking
 * Square's documented shapes.
 *
 * Square assembles an invoice from three objects — a customer, an order
 * carrying the money, and the invoice pointing at both — and publishing is a
 * fourth call. Most of what can go wrong is in that sequence, so most of these
 * are about it.
 */

const CONFIG = { environment: "sandbox", locationId: "L7KQW1ABC" };
const CREDENTIALS = { accessToken: "sq0atp-fake" };

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

let square: FakeSquare | undefined;

async function start(options: Parameters<typeof startFakeSquare>[0] = {}) {
  square = await startFakeSquare(options);
  process.env.SQUARE_API_BASE = square.baseUrl;
}

afterEach(async () => {
  delete process.env.SQUARE_API_BASE;

  const running = square;
  square = undefined;
  await running?.close();
});

function fake(): FakeSquare {
  if (!square) throw new Error("no fake Square running — call start() first");
  return square;
}

describe("verify", () => {
  it("names the location the money will belong to", async () => {
    await start();

    const result = await squareAdapter.verify(CONFIG, CREDENTIALS);

    expect(result).toEqual({
      ok: true,
      value: { accountLabel: "Northside Yard (sandbox)" },
    });
  });

  it("lists the available locations when none was entered", async () => {
    // The id is typed by hand. Answering with the account's own ids beats
    // sending somebody into the Square dashboard to hunt for one.
    await start({
      locations: [
        { id: "L1", name: "Main Shop" },
        { id: "L2", name: "Depot" },
      ],
    });

    const result = await squareAdapter.verify(
      { environment: "sandbox", locationId: "" },
      CREDENTIALS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("Main Shop (L1)");
    expect(result.ok === false && result.error).toContain("Depot (L2)");
  });

  it("catches a location id that belongs to no location here", async () => {
    // Otherwise this surfaces much later, as a confusing failure when an
    // invoice is raised.
    await start();

    const result = await squareAdapter.verify(
      { environment: "sandbox", locationId: "L-WRONG" },
      CREDENTIALS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no location L-WRONG/i);
    expect(result.ok === false && result.error).toContain("L7KQW1ABC");
  });

  it("explains a rejected token in terms of the environment picked", async () => {
    await start();

    const result = await squareAdapter.verify(CONFIG, {
      accessToken: "sq0atp-wrong",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /rejected that access token.*sandbox token will not work against production/is,
    );
  });

  it("names the scopes a token is missing rather than just refusing", async () => {
    await start({
      failWith: {
        status: 403,
        body: {
          errors: [
            {
              category: "AUTHENTICATION_ERROR",
              code: "INSUFFICIENT_SCOPES",
              detail: "This request requires additional scopes.",
            },
          ],
        },
      },
    });

    const result = await squareAdapter.verify(CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /CUSTOMERS_WRITE, ORDERS_WRITE, INVOICES_WRITE and PAYMENTS_READ/,
    );
  });

  it("refuses to call out at all when the token is blank", async () => {
    await start();

    const result = await squareAdapter.verify(CONFIG, { accessToken: "" });

    expect(result.ok).toBe(false);
    expect(fake().requests).toHaveLength(0);
  });

  it("names this build's pinned API version when Square rejects it", async () => {
    // Square's own message never mentions a header, so somebody would go
    // looking at the fields they typed instead of at a constant in the code.
    await start({
      failWith: {
        status: 400,
        body: {
          errors: [
            {
              category: "INVALID_REQUEST_ERROR",
              code: "BAD_REQUEST",
              detail: "The API version is not supported.",
            },
          ],
        },
      },
    });

    const result = await squareAdapter.verify(CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /SQUARE_VERSION in src\/lib\/payments\/square\.ts/,
    );
  });
});

describe("createLink", () => {
  it("returns the public invoice page and the invoice id", async () => {
    await start();

    const result = await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.url).toMatch(/^https:\/\/squareup\.test\/pay\/INV_/);
    expect(result.value.ref).toMatch(/^INV_/);
  });

  it("assembles customer, order, invoice, publish — in that order", async () => {
    await start();
    await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const paths = fake()
      .requests.filter((r) => r.method === "POST")
      .map((r) => r.path);

    expect(paths[0]).toBe("/v2/customers/search");
    expect(paths[1]).toBe("/v2/customers");
    expect(paths[2]).toBe("/v2/orders");
    expect(paths[3]).toBe("/v2/invoices");
    expect(paths[4]).toMatch(/\/publish$/);
  });

  it("puts the money on the order, in the smallest currency unit", async () => {
    await start();
    await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const order = fake().requests.find((r) => r.path === "/v2/orders");
    const body = order?.body as {
      order?: {
        line_items?: { base_price_money?: { amount?: number; currency?: string } }[];
        location_id?: string;
        reference_id?: string;
      };
    };

    expect(body.order?.line_items?.[0].base_price_money).toEqual({
      amount: 89_735,
      currency: "USD",
    });
    expect(body.order?.location_id).toBe("L7KQW1ABC");
    expect(body.order?.reference_id).toBe("INV-1102");
  });

  it("never lets Square deliver the invoice itself", async () => {
    // Matlock One sends the document. Two senders, one debt, two payments.
    await start();
    await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    const invoice = fake().requests.find(
      (r) => r.method === "POST" && r.path === "/v2/invoices",
    );
    const body = invoice?.body as {
      invoice?: {
        delivery_method?: string;
        payment_requests?: { automatic_payment_source?: string }[];
      };
    };

    expect(body.invoice?.delivery_method).toBe("SHARE_MANUALLY");
    // And it must not charge a card on file by itself either.
    expect(body.invoice?.payment_requests?.[0].automatic_payment_source).toBe(
      "NONE",
    );
  });

  it("carries idempotency keys, which Square takes in the body", async () => {
    await start();
    await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    for (const request of fake().requests.filter((r) => r.method === "POST")) {
      if (request.path === "/v2/customers/search") continue;
      expect(request.body.idempotency_key, request.path).toBeTruthy();
      // Square caps these at 45 characters and refuses anything longer.
      expect(String(request.body.idempotency_key).length).toBeLessThanOrEqual(45);
    }
  });

  it("sends the version Square gave it when publishing", async () => {
    // Publishing with a stale version is refused, and the fake enforces that.
    await start();

    const result = await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(true);
    const publish = fake().requests.find((r) => r.path.endsWith("/publish"));
    expect(publish?.body.version).toBe(0);
  });

  it("pins the API version on every call", async () => {
    await start();
    await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    for (const request of fake().requests) {
      expect(request.version, request.path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("reuses an existing customer with the same email", async () => {
    await start({
      existingCustomer: { id: "CUST_EXISTING", email: "desmond@example.test" },
    });

    await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(
      fake().requests.some((r) => r.method === "POST" && r.path === "/v2/customers"),
    ).toBe(false);

    const order = fake().requests.find((r) => r.path === "/v2/orders");
    const body = order?.body as { order?: { customer_id?: string } };
    expect(body.order?.customer_id).toBe("CUST_EXISTING");
  });

  it("creates a customer when the client has no email to match on", async () => {
    await start();

    const result = await squareAdapter.createLink(
      { ...REQUEST, clientEmail: null },
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok).toBe(true);
    expect(
      fake().requests.some((r) => r.path === "/v2/customers/search"),
    ).toBe(false);
  });

  it("refuses before calling out when no location is configured", async () => {
    await start();

    const result = await squareAdapter.createLink(
      REQUEST,
      { environment: "sandbox", locationId: "" },
      CREDENTIALS,
    );

    expect(result.ok).toBe(false);
    expect(fake().requests).toHaveLength(0);
  });

  it("reports a published invoice that came back without a page", async () => {
    await start({ withoutPublicUrl: true });

    const result = await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no payment page/i);
  });

  it("passes a refusal back in Square's own words", async () => {
    await start({
      failWith: {
        status: 400,
        path: "/v2/orders",
        body: {
          errors: [{ code: "BAD_REQUEST", detail: "Invalid currency for location" }],
        },
      },
    });

    const result = await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("Invalid currency for location");
  });
});

describe("listPayments", () => {
  it("reports nothing before the invoice is paid", async () => {
    await start();
    const link = await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    const result = await squareAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("reads the money off the order, under Square's own tender id", async () => {
    await start();
    const link = await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    fake().pay(link.value.ref!, 89_735, "TENDER_1");

    const first = await squareAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );
    const second = await squareAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    expect(first.ok && first.value).toHaveLength(1);
    expect(first.ok && first.value[0]).toMatchObject({
      externalId: "TENDER_1",
      amountCents: 89_735,
    });
    // The same id both times, or a second poll records a second payment.
    expect(second.ok && second.value[0].externalId).toBe("TENDER_1");
  });

  it("reports each part payment separately", async () => {
    // A Square invoice can be settled in pieces, and each tender is its own
    // row against the invoice.
    await start();
    const link = await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    fake().pay(link.value.ref!, 40_000, "TENDER_1");
    fake().pay(link.value.ref!, 49_735, "TENDER_2");

    const result = await squareAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok && result.value.map((p) => p.amountCents)).toEqual([
      40_000, 49_735,
    ]);
  });

  it("treats an invoice with no order as nothing settled yet", async () => {
    // A surprising shape must not read as an error on a screen checked daily.
    await start({ invoiceWithoutOrder: true });
    const link = await squareAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);
    if (!link.ok) throw new Error("setup failed");

    const result = await squareAdapter.listPayments(
      link.value.ref,
      CONFIG,
      CREDENTIALS,
    );

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("refuses to poll an invoice that never had a link", async () => {
    await start();

    const result = await squareAdapter.listPayments(null, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(fake().requests).toHaveLength(0);
  });

  it("explains an invoice Square no longer has", async () => {
    await start();

    const result = await squareAdapter.listPayments(
      "INV_deleted",
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no longer has that invoice/i);
  });
});

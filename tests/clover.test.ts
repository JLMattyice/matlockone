import { afterEach, describe, expect, it } from "vitest";

import { startFakeClover, type FakeClover } from "./support/clover-server";
import { cloverAdapter, createCheckoutSession } from "@/lib/payments/clover";

/**
 * The Clover adapter.
 *
 * Clover is the odd one of the four: its checkout pages expire fifteen minutes
 * after they are made, so the link that goes on an invoice is Matlock One's
 * own `/pay` route and the session is minted when the client clicks it. Most
 * of what is worth pinning down is that shape — that createLink calls nobody,
 * and that the session call sends what Clover expects when it finally runs.
 */

const CONFIG = { environment: "sandbox", merchantId: "MERCH123" };
const CREDENTIALS = { privateKey: "clover-private-key" };

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

const INVOICE = {
  number: "INV-1102",
  description: "Ductwork cleaning",
  balanceCents: 89_735,
  clientName: "Desmond Achterberg",
  clientEmail: "desmond@example.test",
  organizationName: "Matlock Field Services",
};

let clover: FakeClover | undefined;

async function start(options: Parameters<typeof startFakeClover>[0] = {}) {
  clover = await startFakeClover(options);
  process.env.CLOVER_API_BASE = clover.baseUrl;
}

afterEach(async () => {
  delete process.env.CLOVER_API_BASE;

  const running = clover;
  clover = undefined;
  await running?.close();
});

function fake(): FakeClover {
  if (!clover) throw new Error("no fake Clover running — call start() first");
  return clover;
}

describe("createLink", () => {
  it("hands back our own page, not a Clover address", async () => {
    await start();

    const result = await cloverAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(result).toEqual({
      ok: true,
      value: { url: REQUEST.payPageUrl, ref: null },
    });
  });

  it("creates nothing at Clover when the invoice is sent", async () => {
    // A session made now expires in fifteen minutes, long before the email is
    // opened. Calling Clover here would burn a session for nothing.
    await start();
    await cloverAdapter.createLink(REQUEST, CONFIG, CREDENTIALS);

    expect(fake().requests).toHaveLength(0);
  });

  it("refuses when no merchant is configured", async () => {
    await start();

    const result = await cloverAdapter.createLink(
      REQUEST,
      { environment: "sandbox", merchantId: "" },
      CREDENTIALS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/merchant ID/i);
  });
});

describe("createCheckoutSession", () => {
  it("returns the Clover page to send the client to", async () => {
    await start();

    const result = await createCheckoutSession(INVOICE, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.url).toMatch(
      /^https:\/\/checkout\.clover\.test\/sess_/,
    );
  });

  it("sends the merchant header and the key Clover asks for", async () => {
    await start();
    await createCheckoutSession(INVOICE, CONFIG, CREDENTIALS);

    const request = fake().requests[0];
    expect(request.path).toBe("/invoicingcheckoutservice/v1/checkouts");
    expect(request.merchantId).toBe("MERCH123");
    expect(request.auth).toBe("Bearer clover-private-key");
  });

  it("charges the outstanding balance, in the smallest currency unit", async () => {
    await start();
    await createCheckoutSession(INVOICE, CONFIG, CREDENTIALS);

    const body = fake().requests[0].body as {
      shoppingCart?: { lineItems?: { price?: number; unitQty?: number; note?: string }[] };
    };

    expect(body.shoppingCart?.lineItems?.[0].price).toBe(89_735);
    expect(body.shoppingCart?.lineItems?.[0].unitQty).toBe(1);
    // Our number travels with it, so a Clover payment can be traced back by
    // hand — which is the only way it can be traced at all here.
    expect(body.shoppingCart?.lineItems?.[0].note).toContain("INV-1102");
  });

  it("splits the client's name the way Clover's fields demand", async () => {
    await start();
    await createCheckoutSession(INVOICE, CONFIG, CREDENTIALS);

    const body = fake().requests[0].body as {
      customer?: { firstName?: string; lastName?: string; email?: string };
    };

    expect(body.customer).toEqual({
      firstName: "Desmond",
      lastName: "Achterberg",
      email: "desmond@example.test",
    });
  });

  it("copes with a one-word name and no email", async () => {
    await start();
    await createCheckoutSession(
      { ...INVOICE, clientName: "Northside", clientEmail: null },
      CONFIG,
      CREDENTIALS,
    );

    const body = fake().requests[0].body as { customer?: Record<string, string> };
    expect(body.customer).toEqual({ firstName: "Northside" });
  });

  it("refuses a settled invoice without calling out", async () => {
    await start();

    const result = await createCheckoutSession(
      { ...INVOICE, balanceCents: 0 },
      CONFIG,
      CREDENTIALS,
    );

    expect(result.ok).toBe(false);
    expect(fake().requests).toHaveLength(0);
  });

  it("names the wrong-integration-type mistake on a 406", async () => {
    // Clover's own documented symptom, and their message does not say it.
    await start({ failWith: { status: 406 } });

    const result = await createCheckoutSession(INVOICE, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /integration type to Hosted Checkout/i,
    );
  });

  it("explains a rejected key in terms of the environment picked", async () => {
    await start();

    const result = await createCheckoutSession(INVOICE, CONFIG, {
      privateKey: "wrong",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /rejected that private key.*sandbox key will not work against production/is,
    );
  });

  it("explains an unrecognised merchant", async () => {
    await start();

    const result = await createCheckoutSession(
      INVOICE,
      { environment: "sandbox", merchantId: "NOT-MINE" },
      CREDENTIALS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/does not recognise that merchant/i);
  });

  it("reports a checkout that came back with no address", async () => {
    await start({ withoutHref: true });

    const result = await createCheckoutSession(INVOICE, CONFIG, CREDENTIALS);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no address to send the client/i);
  });
});

describe("verify", () => {
  it("opens a real checkout, which is the only proof the token works", async () => {
    // The wrong integration type is the commonest misconfiguration and only
    // this endpoint reveals it. The session is nominal and nobody is given it.
    await start();

    const result = await cloverAdapter.verify(CONFIG, CREDENTIALS);

    expect(result).toEqual({
      ok: true,
      value: { accountLabel: "Clover MERCH123 (sandbox)" },
    });

    const body = fake().requests[0].body as {
      shoppingCart?: { lineItems?: { price?: number }[] };
    };
    expect(body.shoppingCart?.lineItems?.[0].price).toBe(100);
  });

  it("asks for the merchant id before calling out", async () => {
    await start();

    const result = await cloverAdapter.verify(
      { environment: "sandbox", merchantId: "" },
      CREDENTIALS,
    );

    expect(result.ok).toBe(false);
    expect(fake().requests).toHaveLength(0);
  });
});

describe("listPayments", () => {
  it("reports nothing, because each click is its own checkout", async () => {
    // reconciles: false in the catalog says this out loud before anybody
    // connects the account. Returning an empty list rather than an error keeps
    // the reconcile sweep quiet for the providers it runs beside.
    await start();

    const result = await cloverAdapter.listPayments("anything", CONFIG, CREDENTIALS);

    expect(result).toEqual({ ok: true, value: [] });
    expect(fake().requests).toHaveLength(0);
  });
});

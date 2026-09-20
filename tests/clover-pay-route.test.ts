import { randomUUID } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { startFakeClover, type FakeClover } from "./support/clover-server";
import { GET } from "@/app/share/invoice/[token]/pay/route";
import { seal } from "@/lib/secret-box";
import { prisma } from "@/lib/db";

/**
 * The route a Clover invoice actually links to.
 *
 * Everything about this provider hangs on it: the invoice carries this
 * address, and the fifteen-minute Clover session is made here, when the client
 * clicks. These cover what it does with a real database row behind it — who
 * gets sent to Clover, and who gets sent back to their invoice instead.
 */

const ORIGIN = "https://pay.example.test";

/**
 * Connection details are stored encrypted, so a test that saves one needs a
 * key the way a deployment does. Set before any of these run, and restored
 * afterwards so a suite sharing this process is unaffected.
 */
const KEY = "c".repeat(32);
let originalKey: string | undefined;

let clover: FakeClover | undefined;
let organizationId: string;
let clientId: string;

async function seedOrganization() {
  const org = await prisma.organization.create({
    data: { slug: `clover-${randomUUID()}`, name: "Northside Home Services" },
  });

  const client = await prisma.client.create({
    data: {
      organizationId: org.id,
      displayName: "Desmond Achterberg",
      email: "desmond@example.test",
      type: "PERSON",
    },
  });

  return { organizationId: org.id, clientId: client.id };
}

async function connectClover(merchantId = "MERCH123") {
  const sealed = seal(JSON.stringify({ privateKey: "clover-private-key" }));

  await prisma.integration.create({
    data: {
      organizationId,
      kind: "PAYMENT",
      provider: "CLOVER",
      isActive: true,
      config: JSON.stringify({ environment: "sandbox", merchantId }),
      secretCipher: sealed.cipherText,
      secretNonce: sealed.nonce,
      secretTag: sealed.tag,
    },
  });
}

async function seedInvoice(
  overrides: { status?: string; balanceCents?: number } = {},
) {
  return prisma.invoice.create({
    data: {
      organizationId,
      clientId,
      number: `INV-${Math.floor(Math.random() * 100_000)}`,
      title: "Ductwork cleaning",
      status: overrides.status ?? "SENT",
      issueDate: new Date(),
      subtotalCents: 89_735,
      totalCents: 89_735,
      balanceCents: overrides.balanceCents ?? 89_735,
    },
    select: { id: true, publicToken: true, number: true },
  });
}

/** Calls the route the way Next would, with the params it parses from the URL. */
async function visit(token: string) {
  return GET(new Request(`${ORIGIN}/share/invoice/${token}/pay`), {
    params: Promise.resolve({ token }),
  });
}

beforeAll(() => {
  originalKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY;
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

beforeEach(async () => {
  clover = await startFakeClover();
  process.env.CLOVER_API_BASE = clover.baseUrl;

  const seeded = await seedOrganization();
  organizationId = seeded.organizationId;
  clientId = seeded.clientId;
});

afterEach(async () => {
  delete process.env.CLOVER_API_BASE;

  const running = clover;
  clover = undefined;
  await running?.close();
});

describe("the Clover pay route", () => {
  it("mints a session at click time and redirects to Clover", async () => {
    await connectClover();
    const invoice = await seedInvoice();

    const response = await visit(invoice.publicToken);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toMatch(
      /^https:\/\/checkout\.clover\.test\/sess_/,
    );
    // The session is made now, not when the invoice was sent — the whole
    // reason this route exists.
    expect(clover?.requests).toHaveLength(1);
  });

  it("charges the balance as it stands now, not when the link was made", async () => {
    await connectClover();
    const invoice = await seedInvoice();

    // A deposit lands after the email goes out.
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { balanceCents: 40_000, amountPaidCents: 49_735 },
    });

    await visit(invoice.publicToken);

    const body = clover?.requests[0].body as {
      shoppingCart?: { lineItems?: { price?: number }[] };
    };
    expect(body.shoppingCart?.lineItems?.[0].price).toBe(40_000);
  });

  it("sends a draft back to its invoice rather than to a payment page", async () => {
    // Money against a draft leaves it settled-but-still-draft, which is why
    // the rest of the app refuses it too.
    await connectClover();
    const invoice = await seedInvoice({ status: "DRAFT" });

    const response = await visit(invoice.publicToken);

    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/share/invoice/${invoice.publicToken}?pay=not-payable`,
    );
    expect(clover?.requests).toHaveLength(0);
  });

  it("refuses an invoice with nothing left to pay", async () => {
    await connectClover();
    const invoice = await seedInvoice({ balanceCents: 0 });

    const response = await visit(invoice.publicToken);

    expect(response.headers.get("location")).toContain("pay=not-payable");
    expect(clover?.requests).toHaveLength(0);
  });

  it("says nothing about whether an unknown token exists", async () => {
    const response = await visit("tok_nonexistent");

    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/share/invoice/tok_nonexistent?pay=unavailable`,
    );
  });

  it("sends the client back when Clover refuses", async () => {
    // Somebody who wanted to pay should land on their invoice and its other
    // ways to pay, not on an error page.
    await connectClover("NOT-MINE");
    const invoice = await seedInvoice();

    const response = await visit(invoice.publicToken);

    expect(response.headers.get("location")).toContain("pay=unavailable");
  });

  it("sends the client back when no processor is connected at all", async () => {
    const invoice = await seedInvoice();

    const response = await visit(invoice.publicToken);

    expect(response.headers.get("location")).toContain("pay=unavailable");
    expect(clover?.requests).toHaveLength(0);
  });

  it("returns a non-Clover invoice to its own page", async () => {
    // Its link went straight to the processor, so this route has nothing to
    // add — it must not invent a Clover checkout for a Stripe invoice.
    const sealed = seal(JSON.stringify({ secretKey: "sk_test_x" }));
    await prisma.integration.create({
      data: {
        organizationId,
        kind: "PAYMENT",
        provider: "STRIPE",
        isActive: true,
        config: JSON.stringify({}),
        secretCipher: sealed.cipherText,
        secretNonce: sealed.nonce,
        secretTag: sealed.tag,
      },
    });
    const invoice = await seedInvoice();

    const response = await visit(invoice.publicToken);

    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/share/invoice/${invoice.publicToken}`,
    );
    expect(clover?.requests).toHaveLength(0);
  });

  it("never reaches another organization's invoice through its own processor", async () => {
    // The token is the only credential here, so the route must resolve the
    // processor from the invoice's own organization and nowhere else.
    await connectClover();
    const theirs = await seedOrganization();
    const outsider = await prisma.invoice.create({
      data: {
        organizationId: theirs.organizationId,
        clientId: theirs.clientId,
        number: "INV-OTHER",
        status: "SENT",
        issueDate: new Date(),
        subtotalCents: 1_000,
        totalCents: 1_000,
        balanceCents: 1_000,
      },
      select: { publicToken: true },
    });

    const response = await visit(outsider.publicToken);

    // That organization has no processor, so it cannot borrow this one's.
    expect(response.headers.get("location")).toContain("pay=unavailable");
    expect(clover?.requests).toHaveLength(0);
  });
});

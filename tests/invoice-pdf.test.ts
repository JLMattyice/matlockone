import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  buildInvoicePdf,
  formatQuantity,
  wrapText,
  type InvoicePdfInput,
} from "@/lib/pdf/invoice-pdf";
import { invoiceDeletion } from "@/lib/documents";

/**
 * The invoice as a file.
 *
 * This is the document a client keeps, prints, and argues about a year later,
 * so the things worth pinning are that it renders at all, that nothing runs off
 * the page, and that the numbers on it are the numbers in the database.
 */

const base: InvoicePdfInput = {
  organization: {
    name: "Matlock Software Development",
    email: "office@matlocksoftware.test",
    phone: "9195552104",
    addressLine1: "118 Beauchamp Row",
    city: "Fairhaven",
    state: "NC",
    postalCode: "27519",
    currency: "USD",
    locale: "en-US",
    primaryColor: "#2563eb",
  },
  invoice: {
    number: "INV-1006",
    title: "Quarterly maintenance",
    status: "SENT",
    issuedAt: new Date("2026-09-06T12:00:00Z"),
    dueDate: new Date("2026-10-06T12:00:00Z"),
    subtotalCents: 148_000,
    taxCents: 10_360,
    discountCents: 5_000,
    totalCents: 153_360,
    amountPaidCents: 25_000,
    balanceCents: 128_360,
    notes: null,
    paymentUrl: null,
  },
  client: { displayName: "Crossroads Church", email: "office@crossroads.test" },
  address: { line1: "4210 Hollybrook Lane", city: "Millbrook", state: "NC" },
  lineItems: [
    { name: "HVAC tune-up", quantity: 2, unitPriceCents: 42_000, totalCents: 84_000 },
    { name: "Condenser motor", quantity: 1, unitPriceCents: 38_000, totalCents: 38_000 },
  ],
};

const withInvoice = (over: Partial<InvoicePdfInput["invoice"]>): InvoicePdfInput => ({
  ...base,
  invoice: { ...base.invoice, ...over },
});

describe("the document", () => {
  it("is a real PDF", async () => {
    const bytes = await buildInvoicePdf(base);

    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");

    // Parsed back rather than trusted: a file that only *starts* like a PDF is
    // what a reader refuses to open in front of a client.
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(parsed.getTitle()).toBe("Invoice INV-1006");
  });

  it("fits a long invoice onto more than one page rather than off the bottom", async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      name: `Service call ${index + 1} — diagnosis, parts and labour on site`,
      description: "Includes travel, materials and a follow-up check the next week.",
      quantity: 1,
      unitPriceCents: 12_500,
      totalCents: 12_500,
    }));

    const parsed = await PDFDocument.load(
      await buildInvoicePdf({ ...base, lineItems: many }),
    );

    // Forty-five lines cannot fit on one page. If they ever appear to, the
    // overflow is being drawn past the margin where nobody will read it.
    expect(parsed.getPageCount()).toBeGreaterThan(1);
  });

  it("renders with almost nothing filled in", async () => {
    // A one-line invoice from a business that has not set an address, a logo
    // colour or a footer still has to produce a document.
    const bare: InvoicePdfInput = {
      organization: { name: "Sole Trader", currency: "USD", locale: "en-US" },
      invoice: {
        number: "INV-1",
        status: "DRAFT",
        subtotalCents: 5_000,
        taxCents: 0,
        discountCents: 0,
        totalCents: 5_000,
        amountPaidCents: 0,
        balanceCents: 5_000,
      },
      client: { displayName: "A Client" },
      lineItems: [
        { name: "Call-out", quantity: 1, unitPriceCents: 5_000, totalCents: 5_000 },
      ],
    };

    const bytes = await buildInvoicePdf(bare);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it("survives a colour it cannot read", async () => {
    // Branding is user input. A bad value must not take the invoice with it.
    for (const colour of ["", "not-a-colour", "#12", null]) {
      const bytes = await buildInvoicePdf({
        ...base,
        organization: { ...base.organization, primaryColor: colour },
      });
      expect(bytes.length).toBeGreaterThan(1000);
    }
  });

  it("adds a clickable link only when there is something to pay", async () => {
    const withLink = await PDFDocument.load(
      await buildInvoicePdf(
        withInvoice({ paymentUrl: "https://paypal.test/pay/abc" }),
      ),
    );
    const settled = await PDFDocument.load(
      await buildInvoicePdf(
        withInvoice({
          paymentUrl: "https://paypal.test/pay/abc",
          balanceCents: 0,
          amountPaidCents: 153_360,
        }),
      ),
    );

    const annotations = (doc: PDFDocument) =>
      doc.getPage(0).node.Annots()?.size() ?? 0;

    expect(annotations(withLink)).toBeGreaterThan(0);
    // Inviting somebody to pay an invoice they have already settled is how
    // money gets taken twice.
    expect(annotations(settled)).toBe(0);
  });
});

describe("laying out text", () => {
  it("breaks a description across lines instead of off the page", async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const lines = wrapText(
      "Replaced the condenser fan motor and capacitor, flushed the drain line, and checked refrigerant charge against the plate",
      font,
      9.5,
      285,
    );

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 9.5)).toBeLessThanOrEqual(285);
    }
  });

  it("splits a single word too long to fit", async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    // A pasted URL with no spaces in it — the usual cause.
    const lines = wrapText(`https://${"x".repeat(200)}.test/pay`, font, 9, 200);

    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 9)).toBeLessThanOrEqual(200);
    }
  });

  it("writes whole quantities without decimals", () => {
    expect(formatQuantity(2)).toBe("2");
    expect(formatQuantity(3.5)).toBe("3.50");
  });
});

describe("deleting an invoice", () => {
  const invoice = (over: Partial<Parameters<typeof invoiceDeletion>[0]> = {}) =>
    invoiceDeletion({
      status: "DRAFT",
      paymentCount: 0,
      amountPaidCents: 0,
      ...over,
    });

  it("deletes an untouched draft without ceremony", () => {
    const result = invoice();
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeNull();
  });

  it("warns before removing money from the books", () => {
    // The payments cascade with the invoice. Somebody clearing test data has
    // to be told that their income figures move.
    const one = invoice({ status: "PAID", paymentCount: 1, amountPaidCents: 5000 });
    expect(one.allowed).toBe(true);
    expect(one.warning).toMatch(/the payment recorded against it/i);

    const many = invoice({ status: "PAID", paymentCount: 3, amountPaidCents: 5000 });
    expect(many.warning).toMatch(/the 3 payments/i);
  });

  it("warns that a sent invoice leaves a gap", () => {
    const result = invoice({ status: "SENT" });
    expect(result.allowed).toBe(true);
    expect(result.warning).toMatch(/sent to the client/i);
  });

  it("says a cancelled one is already void", () => {
    const result = invoice({ status: "CANCELLED" });
    expect(result.allowed).toBe(true);
    expect(result.warning).toMatch(/already cancelled/i);
  });

  it("never refuses outright", () => {
    // It is the customer's ledger. The app states the cost; it does not
    // decide for them, which only sends people into the database by hand.
    for (const status of ["DRAFT", "SENT", "PAID", "PARTIAL", "OVERDUE", "CANCELLED"]) {
      expect(invoice({ status, paymentCount: 2 }).allowed).toBe(true);
    }
  });
});

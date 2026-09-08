import "server-only";

import {
  PDFDocument,
  PDFName,
  PDFString,
  rgb,
  StandardFonts,
  type PDFFont,
} from "pdf-lib";

import { formatMoney } from "@/lib/money";

/**
 * The invoice as a file a client can keep.
 *
 * Built with pdf-lib and the standard PDF fonts rather than by printing a web
 * page. A headless browser would render the app's own styling, but it means
 * shipping Chromium's rendering path inside a server that already spawns a
 * separate Node — and the invoice would then depend on CSS continuing to lay
 * out identically forever. Drawing it here is more code and far fewer moving
 * parts, and the standard fonts are embedded in the format itself, so nothing
 * is read from disk at runtime.
 *
 * The layout is deliberately plain: a business letterhead, who it is for, what
 * was done, what is owed. It has to survive being printed and stapled to a
 * paper file.
 */

const A4 = { width: 595.28, height: 841.89 };

const MARGIN = 50;
const CONTENT = A4.width - MARGIN * 2;

/** Everything the document needs, so this file never touches the database. */
export type InvoicePdfInput = {
  organization: {
    name: string;
    legalName?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    currency: string;
    locale: string;
    primaryColor?: string | null;
    invoiceFooter?: string | null;
  };
  invoice: {
    number: string;
    title?: string | null;
    status: string;
    issuedAt?: Date | null;
    dueDate?: Date | null;
    subtotalCents: number;
    taxCents: number;
    discountCents: number;
    totalCents: number;
    amountPaidCents: number;
    balanceCents: number;
    notes?: string | null;
    paymentUrl?: string | null;
  };
  client: {
    displayName: string;
    email?: string | null;
    phone?: string | null;
  };
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  } | null;
  lineItems: {
    name: string;
    description?: string | null;
    quantity: number;
    unit?: string | null;
    unitPriceCents: number;
    totalCents: number;
  }[];
};

/** `#2563eb` to a pdf-lib colour, falling back to near-black. */
function parseColor(hex: string | null | undefined) {
  const match = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!match) return rgb(0.06, 0.09, 0.16);

  const value = parseInt(match[1], 16);
  return rgb(
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  );
}

const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.85, 0.87, 0.89);

/**
 * Breaks text to fit a column.
 *
 * A line item description is free text a person typed; without this it runs off
 * the edge of the page and the client never sees the end of it.
 */
export function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    let current = "";

    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;

      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) lines.push(current);

      // A single word longer than the column — a URL, usually. Split it rather
      // than let it overflow.
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = "";
        for (const character of word) {
          if (font.widthOfTextAtSize(chunk + character, size) > maxWidth) {
            lines.push(chunk);
            chunk = character;
          } else {
            chunk += character;
          }
        }
        current = chunk;
      } else {
        current = word;
      }
    }

    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

/** Quantities read as "2" rather than "2.00", but keep real fractions. */
export function formatQuantity(quantity: number) {
  return Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(2);
}

function addressLines(
  address: InvoicePdfInput["address"] | InvoicePdfInput["organization"],
) {
  if (!address) return [];

  const source = address as {
    line1?: string | null;
    addressLine1?: string | null;
    line2?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  };

  const cityLine = [
    source.city,
    [source.state, source.postalCode].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");

  return [
    source.line1 ?? source.addressLine1,
    source.line2 ?? source.addressLine2,
    cityLine,
  ].filter((line): line is string => Boolean(line && line.trim()));
}

function formatDate(date: Date | null | undefined, locale: string) {
  if (!date) return null;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export async function buildInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const { organization: org, invoice, client, lineItems } = input;

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Invoice ${invoice.number}`);
  pdf.setAuthor(org.name);
  pdf.setSubject(invoice.title ?? `Invoice ${invoice.number}`);
  pdf.setCreator("Matlock One");

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const brand = parseColor(org.primaryColor);

  let page = pdf.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);

  const text = (
    value: string,
    options: {
      x?: number;
      size?: number;
      font?: PDFFont;
      color?: ReturnType<typeof rgb>;
      align?: "left" | "right";
      width?: number;
    } = {},
  ) => {
    const size = options.size ?? 9.5;
    const font = options.font ?? regular;
    const width = options.width ?? CONTENT;
    const x =
      options.align === "right"
        ? (options.x ?? MARGIN) + width - font.widthOfTextAtSize(value, size)
        : (options.x ?? MARGIN);

    page.drawText(value, { x, y, size, font, color: options.color ?? INK });
  };

  /** Starts a new page when the next block would run off the bottom. */
  const ensureRoom = (needed: number) => {
    if (y - needed > MARGIN + 40) return;
    page = pdf.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
  };

  // ------------------------------------------------------------ letterhead ---

  text(org.name, { size: 17, font: bold, color: brand });
  text("INVOICE", { size: 17, font: bold, align: "right", color: MUTED });
  y -= 18;

  const orgDetails = [
    org.legalName && org.legalName !== org.name ? org.legalName : null,
    ...addressLines(org),
    [org.phone, org.email].filter(Boolean).join("  ·  ") || null,
    org.website,
  ].filter((line): line is string => Boolean(line));

  const headerRight = [
    invoice.number,
    formatDate(invoice.issuedAt, org.locale)
      ? `Issued ${formatDate(invoice.issuedAt, org.locale)}`
      : null,
    formatDate(invoice.dueDate, org.locale)
      ? `Due ${formatDate(invoice.dueDate, org.locale)}`
      : null,
  ].filter((line): line is string => Boolean(line));

  const headerRows = Math.max(orgDetails.length, headerRight.length);
  for (let row = 0; row < headerRows; row += 1) {
    if (orgDetails[row]) text(orgDetails[row], { size: 8.5, color: MUTED });
    if (headerRight[row]) {
      text(headerRight[row], {
        size: row === 0 ? 10 : 8.5,
        font: row === 0 ? bold : regular,
        align: "right",
        color: row === 0 ? INK : MUTED,
      });
    }
    y -= 12;
  }

  y -= 14;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: MARGIN + CONTENT, y },
    thickness: 1,
    color: brand,
  });
  y -= 24;

  // --------------------------------------------------------------- bill to ---

  text("BILL TO", { size: 7.5, font: bold, color: MUTED });
  y -= 13;
  text(client.displayName, { size: 11, font: bold });
  y -= 13;

  for (const line of [
    ...addressLines(input.address),
    client.email,
    client.phone,
  ].filter((line): line is string => Boolean(line))) {
    text(line, { size: 8.5, color: MUTED });
    y -= 11;
  }

  if (invoice.title) {
    y -= 8;
    text(invoice.title, { size: 10, font: bold });
    y -= 14;
  }

  y -= 12;

  // ----------------------------------------------------------------- items ---

  const columns = {
    description: MARGIN,
    quantity: MARGIN + 300,
    unit: MARGIN + 350,
    total: MARGIN + 430,
  };
  const numberWidth = 65;

  const headerRow = () => {
    text("DESCRIPTION", { size: 7.5, font: bold, color: MUTED });
    text("QTY", {
      size: 7.5,
      font: bold,
      color: MUTED,
      x: columns.quantity,
      width: 40,
      align: "right",
    });
    text("RATE", {
      size: 7.5,
      font: bold,
      color: MUTED,
      x: columns.unit,
      width: numberWidth,
      align: "right",
    });
    text("AMOUNT", {
      size: 7.5,
      font: bold,
      color: MUTED,
      x: columns.total,
      width: numberWidth,
      align: "right",
    });
    y -= 8;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + CONTENT, y },
      thickness: 0.5,
      color: LINE,
    });
    y -= 15;
  };

  headerRow();

  for (const item of lineItems) {
    const nameLines = wrapText(item.name, regular, 9.5, 285);
    const detailLines = item.description?.trim()
      ? wrapText(item.description, regular, 8.5, 285)
      : [];
    const rowHeight = nameLines.length * 12 + detailLines.length * 10;

    ensureRoom(rowHeight + 20);

    // A page break inside the table needs its own heading, or the columns
    // on page two are unlabelled.
    if (y === A4.height - MARGIN) headerRow();

    const rowTop = y;
    for (const line of nameLines) {
      text(line, { size: 9.5 });
      y -= 12;
    }
    for (const line of detailLines) {
      text(line, { size: 8.5, color: MUTED });
      y -= 10;
    }

    y = rowTop;
    text(formatQuantity(item.quantity), {
      size: 9.5,
      x: columns.quantity - 15,
      width: 55,
      align: "right",
      color: MUTED,
    });
    text(money(item.unitPriceCents), {
      size: 9.5,
      x: columns.unit,
      width: numberWidth,
      align: "right",
      color: MUTED,
    });
    text(money(item.totalCents), {
      size: 9.5,
      x: columns.total,
      width: numberWidth,
      align: "right",
    });

    y -= rowHeight + 5;
  }

  // ---------------------------------------------------------------- totals ---

  ensureRoom(120);
  y -= 6;
  page.drawLine({
    start: { x: MARGIN + 300, y },
    end: { x: MARGIN + CONTENT, y },
    thickness: 0.5,
    color: LINE,
  });
  y -= 16;

  const totalRow = (
    label: string,
    value: string,
    options: { strong?: boolean; color?: ReturnType<typeof rgb> } = {},
  ) => {
    text(label, {
      size: options.strong ? 10.5 : 9.5,
      font: options.strong ? bold : regular,
      x: columns.unit - 120,
      width: 170,
      align: "right",
      color: options.color ?? (options.strong ? INK : MUTED),
    });
    text(value, {
      size: options.strong ? 10.5 : 9.5,
      font: options.strong ? bold : regular,
      x: columns.total,
      width: numberWidth,
      align: "right",
      color: options.color ?? INK,
    });
    y -= options.strong ? 17 : 14;
  };

  totalRow("Subtotal", money(invoice.subtotalCents));
  if (invoice.discountCents > 0) {
    totalRow("Discount", `-${money(invoice.discountCents)}`);
  }
  if (invoice.taxCents > 0) totalRow("Tax", money(invoice.taxCents));
  totalRow("Total", money(invoice.totalCents), { strong: true });

  if (invoice.amountPaidCents > 0) {
    totalRow("Paid", `-${money(invoice.amountPaidCents)}`);
  }

  // The number the client actually acts on.
  totalRow(
    invoice.balanceCents > 0 ? "Amount due" : "Balance",
    money(invoice.balanceCents),
    { strong: true, color: invoice.balanceCents > 0 ? brand : INK },
  );

  // ------------------------------------------------------------ how to pay ---

  if (invoice.paymentUrl && invoice.balanceCents > 0) {
    ensureRoom(60);
    y -= 14;

    text("PAY ONLINE", { size: 7.5, font: bold, color: MUTED });
    y -= 13;

    // Drawn as text *and* registered as a link annotation: readable on a
    // printout, clickable in a reader. One rectangle per wrapped line, since a
    // long URL breaks across two.
    const annotations = [];

    for (const line of wrapText(invoice.paymentUrl, regular, 9, CONTENT)) {
      const width = regular.widthOfTextAtSize(line, 9);
      page.drawText(line, { x: MARGIN, y, size: 9, font: regular, color: brand });

      annotations.push(
        pdf.context.register(
          pdf.context.obj({
            Type: "Annot",
            Subtype: "Link",
            Rect: [MARGIN, y - 2, MARGIN + width, y + 10],
            Border: [0, 0, 0],
            A: pdf.context.obj({
              Type: "Action",
              S: "URI",
              URI: PDFString.of(invoice.paymentUrl),
            }),
          }),
        ),
      );

      y -= 12;
    }

    page.node.set(PDFName.of("Annots"), pdf.context.obj(annotations));
  }

  // -------------------------------------------------------------- closing ---

  const closing = [invoice.notes, org.invoiceFooter].filter(
    (value): value is string => Boolean(value && value.trim()),
  );

  if (closing.length > 0) {
    ensureRoom(60);
    y -= 16;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + CONTENT, y },
      thickness: 0.5,
      color: LINE,
    });
    y -= 16;

    for (const block of closing) {
      for (const line of wrapText(block, regular, 8.5, CONTENT)) {
        ensureRoom(20);
        text(line, { size: 8.5, color: MUTED });
        y -= 11;
      }
      y -= 6;
    }
  }

  return pdf.save();
}

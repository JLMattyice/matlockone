import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The limit on share links that do not exist.
 *
 * Driven through the real share actions and the pay redirect, against the test
 * database, with only the request stood in for: the address it came from.
 * What is pinned is the shape of the limit — misses are counted, real links
 * never are, and an address past it gets nothing from any link — because each
 * of those is a different way for the limit to be either useless or in a
 * paying client's way.
 */

const request = vi.hoisted(() => ({ address: "203.0.113.7" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": request.address }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { renderToStaticMarkup } from "react-dom/server";

import PublicEstimatePage from "@/app/share/estimate/[token]/page";
import PublicInvoicePage from "@/app/share/invoice/[token]/page";
import { GET as payRedirect } from "@/app/share/invoice/[token]/pay/route";
import { ShareRefused } from "@/app/share/refused";
import { respondToEstimate } from "@/app/share/estimate/[token]/actions";
import { markInvoiceViewed } from "@/app/share/invoice/[token]/actions";
import { prisma } from "@/lib/db";
import { peek, SHARE_MISSES_PER_IP } from "@/lib/rate-limit";
import { shareAllowed } from "@/lib/share-guard";

let invoiceToken: string;
let invoiceId: string;
let estimateToken: string;
let estimateId: string;

const guess = () => `c${randomUUID().replace(/-/g, "").slice(0, 24)}`;

async function missTimes(count: number) {
  for (let i = 0; i < count; i++) await markInvoiceViewed(guess());
}

beforeEach(async () => {
  // Hosted: the limit is off on a desktop install, which this database and
  // local file storage would otherwise look like.
  vi.stubEnv("STORAGE_PROVIDER", "s3");

  // Each test from an address of its own, so counts cannot carry across.
  request.address = `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID()}`;

  const org = await prisma.organization.create({
    data: { slug: `share-${randomUUID()}`, name: "Share Test Co" },
  });
  const client = await prisma.client.create({
    data: { organizationId: org.id, displayName: "Wen Okafor", type: "PERSON" },
  });

  const invoice = await prisma.invoice.create({
    data: {
      organizationId: org.id,
      clientId: client.id,
      number: "INV-8801",
      status: "SENT",
      issueDate: new Date(),
      subtotalCents: 40_000,
      totalCents: 40_000,
      balanceCents: 40_000,
    },
  });
  invoiceToken = invoice.publicToken;
  invoiceId = invoice.id;

  const estimate = await prisma.estimate.create({
    data: {
      organizationId: org.id,
      clientId: client.id,
      number: "EST-8801",
      status: "SENT",
      issueDate: new Date(),
      subtotalCents: 40_000,
      totalCents: 40_000,
    },
  });
  estimateToken = estimate.publicToken;
  estimateId = estimate.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("share links", () => {
  it("never count a real link, however often it is opened", async () => {
    for (let i = 0; i < 40; i++) await markInvoiceViewed(invoiceToken);

    expect(await shareAllowed()).toEqual({ ok: true });
    expect(await prisma.rateLimit.count({ where: { key: { contains: request.address } } })).toBe(0);
  });

  it("let an address through while it has misses to spare", async () => {
    await missTimes(SHARE_MISSES_PER_IP.limit - 1);

    expect(await shareAllowed()).toEqual({ ok: true });

    await markInvoiceViewed(invoiceToken);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe("VIEWED");
  });

  it("turn an address away from every link once it has missed too often", async () => {
    await missTimes(SHARE_MISSES_PER_IP.limit);

    const verdict = await shareAllowed();
    expect(verdict.ok).toBe(false);

    // A real link, opened from that address: nothing happens. Whether it was
    // real must not be something the guesser can learn.
    await markInvoiceViewed(invoiceToken);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe("SENT");
  });

  it("leave every other address alone", async () => {
    await missTimes(SHARE_MISSES_PER_IP.limit);

    request.address = `192.0.2.10-${randomUUID()}`;

    expect(await shareAllowed()).toEqual({ ok: true });
    await markInvoiceViewed(invoiceToken);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe("VIEWED");
  });

  it("refuse an estimate response from that address, and say when to try again", async () => {
    await missTimes(SHARE_MISSES_PER_IP.limit);

    const result = await respondToEstimate(estimateToken, "ACCEPTED");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Too many links .* Try again in/);
    const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    expect(estimate.status).toBe("SENT");
  });

  it("count a wrong estimate link as a miss too", async () => {
    for (let i = 0; i < SHARE_MISSES_PER_IP.limit; i++) {
      await respondToEstimate(guess(), "ACCEPTED");
    }

    expect((await shareAllowed()).ok).toBe(false);
  });

  it("turn the pay redirect away from that address", async () => {
    await missTimes(SHARE_MISSES_PER_IP.limit);

    const response = await payRedirect(
      new Request(`https://www.matlockone.com/share/invoice/${invoiceToken}/pay`),
      { params: Promise.resolve({ token: invoiceToken }) },
    );

    expect(response.headers.get("location")).toContain("pay=too-many");
  });

  it("do nothing on a desktop install, where the whole office shares one address", async () => {
    vi.stubEnv("STORAGE_PROVIDER", "local");

    await missTimes(SHARE_MISSES_PER_IP.limit + 10);

    expect(await shareAllowed()).toEqual({ ok: true });
  });
});

describe("the share pages", () => {
  const invoicePage = (token: string) =>
    PublicInvoicePage({
      params: Promise.resolve({ token }),
      searchParams: Promise.resolve({}),
    }) as Promise<React.ReactElement>;

  it("show an address past the limit the refusal, and nothing of the document", async () => {
    await missTimes(SHARE_MISSES_PER_IP.limit);

    const page = await invoicePage(invoiceToken);
    expect(page.type).toBe(ShareRefused);

    const html = renderToStaticMarkup(page);
    expect(html).toContain("This link can’t be opened right now");
    // The window opened with the first miss moments ago, so the whole hour is left.
    expect(html).toContain("Try again in an hour");
    // Refused exactly as a made-up link would be: no number, no client.
    expect(html).not.toContain("INV-8801");
    expect(html).not.toContain("Wen Okafor");

    const estimate = (await PublicEstimatePage({
      params: Promise.resolve({ token: estimateToken }),
    })) as React.ReactElement;
    expect(estimate.type).toBe(ShareRefused);
  });

  it("answer a wrong link with not found, and count it", async () => {
    await expect(invoicePage(guess())).rejects.toThrow();

    const standing = await peek(`share:miss:${request.address}`, SHARE_MISSES_PER_IP);
    expect(standing.remaining).toBe(SHARE_MISSES_PER_IP.limit - 1);
  });

  it("render a real link as the invoice", async () => {
    const page = await invoicePage(invoiceToken);
    expect(page.type).not.toBe(ShareRefused);
  });
});

describe("peek", () => {
  it("reads a limit without spending an attempt", async () => {
    const key = `peek-test:${randomUUID()}`;

    for (let i = 0; i < 5; i++) {
      expect((await peek(key, SHARE_MISSES_PER_IP)).ok).toBe(true);
    }
    expect(await prisma.rateLimit.count({ where: { key } })).toBe(0);
  });
});

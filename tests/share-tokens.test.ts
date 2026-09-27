import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { getEstimateByToken } from "@/app/(app)/estimates/queries";
import { getInvoiceByToken } from "@/app/(app)/invoices/queries";
import { prisma } from "@/lib/db";

/**
 * The code at the end of a share link.
 *
 * It is the whole credential: whoever has the link sees the invoice or the
 * estimate, and can accept one or pay the other. So a new one is 32
 * characters from a cryptographic source, nothing in it taken from the clock
 * or a counter — and a link sent before the change still opens, because a
 * client is holding it.
 */

async function business() {
  const org = await prisma.organization.create({
    data: { slug: `tokens-${randomUUID()}`, name: "Cedar Row Joinery" },
  });
  const client = await prisma.client.create({
    data: { organizationId: org.id, displayName: "Maren Okonkwo", type: "PERSON" },
  });
  return { orgId: org.id, clientId: client.id };
}

let numbered = 0;
const invoiceFor = (b: { orgId: string; clientId: string }, publicToken?: string) =>
  prisma.invoice.create({
    data: {
      organizationId: b.orgId,
      clientId: b.clientId,
      number: `INV-T${++numbered}`,
      issueDate: new Date(),
      ...(publicToken ? { publicToken } : {}),
    },
  });

const URL_SAFE_32 = /^[A-Za-z0-9_-]{32}$/;

describe("a new share link", () => {
  it("is 32 URL-safe characters on an invoice and on an estimate", async () => {
    const b = await business();

    const invoice = await invoiceFor(b);
    const estimate = await prisma.estimate.create({
      data: { organizationId: b.orgId, clientId: b.clientId, number: "EST-T1", issueDate: new Date() },
    });

    expect(invoice.publicToken).toMatch(URL_SAFE_32);
    expect(estimate.publicToken).toMatch(URL_SAFE_32);
  });

  it("shares nothing with the one made just before it", async () => {
    // A cuid made a moment after another starts with the same time and the
    // next counter value; knowing one told you most of the next. These do not.
    const b = await business();
    const tokens = [];
    for (let n = 0; n < 50; n++) tokens.push((await invoiceFor(b)).publicToken);

    expect(new Set(tokens).size).toBe(50);
    const prefixes = new Set(tokens.map((token) => token.slice(0, 6)));
    expect(prefixes.size).toBe(50);
  });
});

describe("a link sent before the change", () => {
  it("still opens the invoice it was sent for", async () => {
    const b = await business();
    const invoice = await invoiceFor(b, "cmg1x7k2p0000abcd1234wxyz");

    expect((await getInvoiceByToken("cmg1x7k2p0000abcd1234wxyz"))?.id).toBe(invoice.id);
  });

  it("still opens the estimate it was sent for", async () => {
    const b = await business();
    const estimate = await prisma.estimate.create({
      data: {
        organizationId: b.orgId,
        clientId: b.clientId,
        number: "EST-OLD",
        issueDate: new Date(),
        publicToken: "cmg1x7k2p0001efgh5678stuv",
      },
    });

    expect((await getEstimateByToken("cmg1x7k2p0001efgh5678stuv"))?.id).toBe(estimate.id);
  });
});

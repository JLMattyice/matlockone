import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A customer accepting an estimate online, and signing it by typing their
 * name.
 *
 * What is pinned is the record, since the record is what makes a typed name
 * a signature: nothing is accepted without the name and the tick; the name,
 * time, address, browser and an exact copy of what was signed are kept; it
 * cannot be signed twice; and the office hears of it, as it does when it
 * marks an estimate accepted itself.
 */

const request = vi.hoisted(() => ({ address: "203.0.113.9" }));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-forwarded-for": `${request.address}, 10.0.0.1`,
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { respondToEstimate } from "@/app/share/estimate/[token]/actions";
import { prisma } from "@/lib/db";
import {
  cleanSignatureName,
  estimateVersion,
  requestAddress,
  signedSnapshot,
  snapshotHash,
  type SignableEstimate,
} from "@/lib/estimate-signature";

// ------------------------------------------------------------- the record ---

const base: SignableEstimate = {
  number: "EST-1001",
  title: "Spring clean-up",
  issueDate: new Date("2026-10-01T14:00:00Z"),
  expiresAt: null,
  subtotalCents: 13_000,
  discountCents: 0,
  taxRateBp: 0,
  taxCents: 0,
  totalCents: 13_000,
  notes: null,
  terms: "Half on acceptance.",
  lineItems: [
    { name: "Lawn mowing", description: null, quantity: 2, unit: "visit", unitPriceCents: 6_500, totalCents: 13_000 },
  ],
};

describe("what a signature records", () => {
  it("takes a real name, tidied, and nothing else", () => {
    expect(cleanSignatureName("  Jane   Q.  Doe ")).toBe("Jane Q. Doe");
    expect(cleanSignatureName("J")).toBeNull();
    expect(cleanSignatureName("x".repeat(121))).toBeNull();
    expect(cleanSignatureName("Jane\u0000Doe")).toBe("JaneDoe");
    expect(cleanSignatureName(42)).toBeNull();
  });

  it("reads the visitor's address from in front of the proxy", () => {
    expect(requestAddress(new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }))).toBe("198.51.100.4");
    expect(requestAddress(new Headers({ "x-real-ip": "198.51.100.5" }))).toBe("198.51.100.5");
    expect(requestAddress(new Headers())).toBeNull();
  });

  it("fingerprints exactly what was signed: any change to price or terms is a different version", () => {
    const hash = snapshotHash(signedSnapshot(base));
    expect(snapshotHash(signedSnapshot({ ...base }))).toBe(hash);
    expect(snapshotHash(signedSnapshot({ ...base, terms: "Paid on completion." }))).not.toBe(hash);
    expect(
      snapshotHash(
        signedSnapshot({ ...base, lineItems: [{ ...base.lineItems[0], unitPriceCents: 6_000 }] }),
      ),
    ).not.toBe(hash);
  });
});

// ------------------------------------------------------------- the action ---

const orgs: string[] = [];
let organizationId: string;
let ownerId: string;
let token: string;
let estimateId: string;

beforeEach(async () => {
  request.address = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  const org = await prisma.organization.create({
    data: { slug: `sign-${randomUUID()}`, name: "Signature Test Co", estimateFooter: "Half on acceptance." },
  });
  orgs.push(org.id);
  organizationId = org.id;
  const owner = await prisma.user.create({
    data: { organizationId, email: `${randomUUID()}@test.local`, name: "Owner", passwordHash: "x", role: "OWNER" },
  });
  ownerId = owner.id;
  const client = await prisma.client.create({
    data: { organizationId, displayName: "Jane Doe", type: "PERSON" },
  });
  const estimate = await prisma.estimate.create({
    data: {
      organizationId,
      clientId: client.id,
      number: "EST-1001",
      status: "SENT",
      sentAt: new Date(),
      subtotalCents: 13_000,
      totalCents: 13_000,
      lineItems: {
        create: [{ name: "Lawn mowing", quantity: 2, unit: "visit", unitPriceCents: 6_500, totalCents: 13_000 }],
      },
    },
  });
  token = estimate.publicToken;
  estimateId = estimate.id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});


/** What the customer's page hands back with a signature: the version it showed. */
async function versionOf(publicToken: string) {
  const shown = await prisma.estimate.findUniqueOrThrow({
    where: { publicToken },
    include: { lineItems: { orderBy: { sortOrder: "asc" } }, organization: { select: { estimateFooter: true } } },
  });
  return estimateVersion(shown, shown.organization.estimateFooter);
}

const sign = async (name: string, agreed = true) =>
  respondToEstimate(token, "ACCEPTED", { signature: { name, agreed }, version: await versionOf(token) });

describe("accepting online", () => {
  it("will not accept without a name and the tick", async () => {
    expect(await sign(" ")).toEqual({ ok: false, error: "Type your full name to sign." });
    expect(await sign("Jane Doe", false)).toEqual({ ok: false, error: "Tick the box to agree to this estimate." });
    expect(await respondToEstimate(token, "ACCEPTED")).toEqual({ ok: false, error: "Type your full name to sign." });
    expect((await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } })).status).toBe("SENT");
  });

  it("keeps the name, time, address, browser and an exact copy of what was signed", async () => {
    expect(await sign("Jane Doe")).toEqual({ ok: true });

    const signed = await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    expect(signed).toMatchObject({
      status: "ACCEPTED",
      signedName: "Jane Doe",
      signedIp: request.address,
      signedUserAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    });
    expect(signed.signedAt).toEqual(signed.acceptedAt);

    // The copy carries the terms the page showed — the business's own footer.
    const snapshot = JSON.parse(signed.signedSnapshot!);
    expect(snapshot).toMatchObject({ number: "EST-1001", totalCents: 13_000, terms: "Half on acceptance." });
    expect(snapshot.lines).toEqual([["Lawn mowing", null, 2, "visit", 6_500, 13_000]]);
    expect(signed.signedHash).toBe(snapshotHash(signed.signedSnapshot!));
  });

  it("is only for the version the customer saw: an edit saved after the page opened must be read first", async () => {
    const seen = await versionOf(token);
    await prisma.estimateLineItem.updateMany({ where: { estimateId }, data: { unitPriceCents: 9_500, totalCents: 19_000 } });
    await prisma.estimate.update({ where: { id: estimateId }, data: { subtotalCents: 19_000, totalCents: 19_000 } });

    expect(await respondToEstimate(token, "ACCEPTED", { signature: { name: "Jane Doe", agreed: true }, version: seen })).toEqual({
      ok: false,
      error: "This estimate was updated after you opened it. Reload the page to see the latest, then sign.",
    });
    expect((await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } })).status).toBe("SENT");

    // Reloaded, they see the new price and can sign it.
    expect(await sign("Jane Doe")).toEqual({ ok: true });
    expect(JSON.parse((await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } })).signedSnapshot!).totalCents).toBe(19_000);
  });

  it("cannot be signed twice", async () => {
    await sign("Jane Doe");
    expect(await sign("Someone Else")).toEqual({ ok: false, error: "This estimate was already accepted." });
    expect((await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } })).signedName).toBe("Jane Doe");
  });

  it("tells the office, and writes it on the timeline", async () => {
    await sign("Jane Doe");

    expect(await prisma.notification.findMany({ where: { organizationId }, select: { userId: true, type: true, title: true, body: true } })).toEqual([
      { userId: ownerId, type: "ESTIMATE_RESPONSE", title: "Jane Doe accepted estimate EST-1001", body: "Signed by Jane Doe." },
    ]);
    const [entry] = await prisma.auditLog.findMany({ where: { organizationId } });
    expect(entry).toMatchObject({ action: "estimate.accepted", entityId: estimateId, userId: null });
    expect(entry.summary).toBe("Estimate EST-1001 accepted and signed by Jane Doe");
  });

  it("declines with a reason, and the office hears that too", async () => {
    expect(await respondToEstimate(token, "DECLINED", { reason: "Went with someone else" })).toEqual({ ok: true });
    expect(await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } })).toMatchObject({
      status: "DECLINED",
      declineReason: "Went with someone else",
      signedName: null,
    });
    expect(await prisma.notification.count({ where: { organizationId, type: "ESTIMATE_RESPONSE" } })).toBe(1);
  });
});

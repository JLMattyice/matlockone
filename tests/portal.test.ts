import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The customer portal and the public "Request service" form.
 *
 * Both are pages for people who never sign in, so what is pinned is mostly
 * about what they can reach: a portal link shows one customer's own records
 * and nobody else's, drafts and cancelled work stay out of it, and replacing
 * the link shuts the old one. The form turns a request into a lead with its
 * details, tells the office, files a portal request under its customer, and
 * holds up against bots, floods, a switched-off form and the demo.
 */

const request = vi.hoisted(() => ({ address: "198.51.100.1" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": request.address }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { renderToStaticMarkup } from "react-dom/server";

import PortalPage from "@/app/portal/[token]/page";
import { submitServiceRequest } from "@/app/request/[slug]/actions";
import { prisma } from "@/lib/db";
import { ensurePortalToken, portalView, replacePortalToken } from "@/lib/portal";

const orgs: string[] = [];
let organizationId: string;
let slug: string;
let clientId: string;

async function makeBusiness(extra: { isDemo?: boolean; requestsEnabled?: boolean } = {}) {
  slug = `portal-${randomUUID()}`;
  const org = await prisma.organization.create({
    data: { slug, name: "Portal Test Co", ...extra },
  });
  orgs.push(org.id);
  organizationId = org.id;
  await prisma.user.create({
    data: { organizationId, email: `${randomUUID()}@test.local`, name: "Owner", passwordHash: "x", role: "OWNER" },
  });
  const client = await prisma.client.create({
    data: { organizationId, displayName: "Jane Doe", firstName: "Jane", email: "jane@example.com", type: "PERSON" },
  });
  clientId = client.id;
}

beforeEach(async () => {
  request.address = `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID()}`;
  vi.stubEnv("STORAGE_PROVIDER", "s3");
  await makeBusiness();
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

const day = 24 * 60 * 60 * 1000;

describe("the portal link", () => {
  it("is made once, kept, and replaced on demand — the old one then shows nothing", async () => {
    const first = (await ensurePortalToken(clientId))!;
    expect(first).toHaveLength(32);
    expect(await ensurePortalToken(clientId)).toBe(first);

    await replacePortalToken(organizationId, clientId);
    const second = (await ensurePortalToken(clientId))!;
    expect(second).not.toBe(first);
    expect(await portalView(first)).toBeNull();
    expect(await portalView(second)).not.toBeNull();
  });

  it("shows nothing for a made-up token, or for an archived customer", async () => {
    expect(await portalView("not-a-real-portal-token-at-all")).toBeNull();
    const token = (await ensurePortalToken(clientId))!;
    await prisma.client.update({ where: { id: clientId }, data: { status: "ARCHIVED" } });
    expect(await portalView(token)).toBeNull();
  });
});

describe("what the portal shows", () => {
  it("shows this customer's booked and done work, estimates to answer, and invoices to pay — nobody else's, and no drafts", async () => {
    const other = await prisma.client.create({ data: { organizationId, displayName: "Someone Else", type: "PERSON" } });
    const now = Date.now();

    await prisma.job.createMany({
      data: [
        { organizationId, clientId, number: "J-1", title: "Spring clean-up", status: "SCHEDULED", scheduledStart: new Date(now + 2 * day) },
        { organizationId, clientId, number: "J-2", title: "Gutter clean", status: "COMPLETED", scheduledStart: new Date(now - 10 * day), completedAt: new Date(now - 10 * day) },
        { organizationId, clientId, number: "J-3", title: "Cancelled visit", status: "CANCELLED", scheduledStart: new Date(now + 3 * day) },
        { organizationId, clientId: other.id, number: "J-4", title: "Their visit", status: "SCHEDULED", scheduledStart: new Date(now + 2 * day) },
      ],
    });
    await prisma.estimate.createMany({
      data: [
        { organizationId, clientId, number: "EST-1", status: "SENT", totalCents: 50_000 },
        { organizationId, clientId, number: "EST-2", status: "DRAFT", totalCents: 70_000 },
        { organizationId, clientId, number: "EST-3", status: "SENT", totalCents: 10_000, expiresAt: new Date(now - day) },
      ],
    });
    await prisma.invoice.createMany({
      data: [
        { organizationId, clientId, number: "INV-1", status: "SENT", totalCents: 20_000, balanceCents: 20_000 },
        { organizationId, clientId, number: "INV-2", status: "PAID", totalCents: 30_000, amountPaidCents: 30_000, balanceCents: 0, paidAt: new Date() },
        { organizationId, clientId, number: "INV-3", status: "DRAFT", totalCents: 40_000, balanceCents: 40_000 },
        { organizationId, clientId, number: "INV-4", status: "CANCELLED", totalCents: 50_000, balanceCents: 50_000 },
        { organizationId, clientId: other.id, number: "INV-5", status: "SENT", totalCents: 60_000, balanceCents: 60_000 },
      ],
    });

    const view = (await portalView((await ensurePortalToken(clientId))!))!;
    expect(view.upcoming.map((job) => job.title)).toEqual(["Spring clean-up"]);
    expect(view.past.map((job) => job.title)).toEqual(["Gutter clean"]);
    expect(view.toAnswer.map((estimate) => estimate.number)).toEqual(["EST-1"]);
    expect(view.toPay.map((invoice) => invoice.number)).toEqual(["INV-1"]);
    expect(view.paid.map((invoice) => invoice.number)).toEqual(["INV-2"]);
  });

  it("renders as the customer's page, with a way to pay and to ask for more", async () => {
    await prisma.invoice.create({
      data: { organizationId, clientId, number: "INV-9", status: "SENT", totalCents: 12_345, balanceCents: 12_345 },
    });
    const token = (await ensurePortalToken(clientId))!;
    const html = renderToStaticMarkup(await PortalPage({ params: Promise.resolve({ token }) }));

    expect(html).toContain("Hello, Jane");
    expect(html).toContain("$123.45");
    expect(html).toMatch(/href="\/share\/invoice\/[^"]+"[^>]*>Pay</);
    expect(html).toContain(`/request/${slug}?for=${token}`);
  });
});

// --------------------------------------------------------- request form ---

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const ask = (fields: Record<string, string> = {}) =>
  submitServiceRequest(
    slug,
    form({
      name: "Sam Lee",
      phone: "865-555-0100",
      email: "",
      service: "Gutter cleaning",
      description: "Gutters overflowing on the back of the house.",
      line1: "14 Elm Ct",
      city: "Lenoir City",
      state: "TN",
      postalCode: "37771",
      preferredDate: "2026-10-20",
      preferredTime: "MORNING",
      ...fields,
    }),
  );

describe("the request form", () => {
  it("turns a request into a new lead with its details, and tells the office", async () => {
    expect(await ask()).toEqual({ ok: true });

    const lead = await prisma.lead.findFirstOrThrow({ where: { organizationId }, include: { notes: true } });
    expect(lead).toMatchObject({ name: "Sam Lee", phone: "865-555-0100", email: null, source: "WEBSITE", status: "NEW", clientId: null });
    expect(lead.notes[0].body).toBe(
      [
        "Requested on the website form.",
        "Service: Gutter cleaning",
        "Where: 14 Elm Ct, Lenoir City, TN 37771",
        "Preferred: 2026-10-20, morning",
        "",
        "Gutters overflowing on the back of the house.",
      ].join("\n"),
    );

    const [notice] = await prisma.notification.findMany({ where: { organizationId } });
    expect(notice).toMatchObject({ type: "SERVICE_REQUEST", title: "New request from Sam Lee", actionUrl: `/leads/${lead.id}` });
  });

  it("files a request sent from the portal under its customer", async () => {
    const token = (await ensurePortalToken(clientId))!;
    await ask({ name: "Jane Doe", for: token });
    const lead = await prisma.lead.findFirstOrThrow({ where: { organizationId }, include: { notes: true } });
    expect(lead).toMatchObject({ clientId, source: "REPEAT" });
    expect(lead.notes[0].body).toMatch(/^Requested from Jane Doe's portal\./);
  });

  it("asks for a way to reach them, and refuses what is not a photo", async () => {
    expect(await ask({ phone: "", email: "" })).toEqual({
      ok: false,
      fieldErrors: { phone: "Leave a phone number or an email so we can reach you." },
    });

    const data = form({ name: "Sam Lee", phone: "865-555-0100", description: "Leaky tap", preferredTime: "ANY" });
    data.append("photos", new File(["MZ"], "invoice.exe", { type: "application/x-msdownload" }));
    expect(await submitServiceRequest(slug, data)).toEqual({ ok: false, error: "Photos only, each under 4 MB." });
    expect(await prisma.lead.count({ where: { organizationId } })).toBe(0);
  });

  it("quietly drops what a bot fills in, and stops a flood from one address", async () => {
    expect(await ask({ company_website: "http://spam.example" })).toEqual({ ok: true });
    expect(await prisma.lead.count({ where: { organizationId } })).toBe(0);

    for (let i = 0; i < 5; i++) expect(await ask()).toEqual({ ok: true });
    expect(await ask()).toMatchObject({ ok: false, error: expect.stringMatching(/^Too many requests/) });
    expect(await prisma.lead.count({ where: { organizationId } })).toBe(5);
  });

  it("is closed when the business turns it off, and in the demo", async () => {
    await makeBusiness({ requestsEnabled: false });
    expect(await ask()).toEqual({ ok: false, error: "This business isn't taking requests online right now." });

    await makeBusiness({ isDemo: true });
    expect(await ask()).toMatchObject({ ok: false, error: expect.stringMatching(/demo/) });
    expect(await prisma.lead.count({ where: { organizationId } })).toBe(0);
  });
});

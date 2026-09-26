import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The demo business: open to look at, closed to change.
 *
 * Driven through the real requireContext, a real session and the real actions
 * and routes, against the test database. Only the request is stood in for —
 * its cookie and its headers — because the thing being decided is exactly
 * what a request looks like: a page being opened, or something being sent.
 */

const request = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: {} as Record<string, string>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined,
    set: (name: string, value: string) => {
      request.cookies.set(name, value);
    },
    delete: (name: string) => {
      request.cookies.delete(name);
    },
  }),
  headers: async () => new Headers(request.headers),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { NextRequest } from "next/server";

import { POST as uploadTicket } from "@/app/api/files/upload-ticket/route";
import { addNote } from "@/app/(app)/notes/actions";
import { respondToEstimate } from "@/app/share/estimate/[token]/actions";
import { markInvoiceViewed } from "@/app/share/invoice/[token]/actions";
import { IDLE } from "@/lib/action-state";
import { requireContext } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { DEMO_OWNER_EMAIL, demoAvailable } from "@/lib/demo";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { sweepEveryBusiness } from "@/lib/workflows/run";

const SAVING = { "next-action": "7f3e9a" };

let demo: { orgId: string; clientId: string; session: string };
let real: { orgId: string; session: string };

async function business(name: string, isDemo: boolean) {
  const org = await prisma.organization.create({
    data: { slug: `demo-test-${randomUUID()}`, name, isDemo },
  });
  const owner = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `owner-${randomUUID()}@example.test`,
      name: "Alex Rivera",
      passwordHash: "x",
      role: "OWNER",
    },
  });
  const client = await prisma.client.create({
    data: { organizationId: org.id, displayName: "Andre Bellamy", type: "PERSON" },
  });

  await createSession(owner.id);
  const session = request.cookies.get(SESSION_COOKIE)!;

  return { orgId: org.id, clientId: client.id, session };
}

const signInAs = (session: string) => request.cookies.set(SESSION_COOKIE, session);

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  request.cookies.clear();
  request.headers = {};

  demo = await business("Northside Home Services", true);
  const other = await business("Andre's Electric", false);
  real = { orgId: other.orgId, session: other.session };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("in the demo", () => {
  it("any page opens", async () => {
    signInAs(demo.session);

    const ctx = await requireContext();

    expect(ctx.org.isDemo).toBe(true);
  });

  it("a save is turned away, and told where it came from", async () => {
    signInAs(demo.session);
    request.headers = {
      ...SAVING,
      host: "www.matlockone.com",
      referer: "https://www.matlockone.com/jobs/new?client=abc",
    };

    await expect(requireContext()).rejects.toThrow(
      `NEXT_REDIRECT /demo?back=${encodeURIComponent("/jobs/new?client=abc")}`,
    );
  });

  it("a form sent with JavaScript off is turned away too", async () => {
    // No Next-Action header on a plain form post, but the action still runs.
    signInAs(demo.session);
    request.headers = { "content-type": "multipart/form-data; boundary=----x" };

    await expect(requireContext()).rejects.toThrow("NEXT_REDIRECT /demo");
  });

  it("the page a refused save is sent to still draws", async () => {
    // Next draws a redirect's destination inside the action's own request,
    // forwarding its headers — the form's content type included — with an RSC
    // header added and the action header removed. Treated as another save,
    // the page the visitor lands on came back empty.
    signInAs(demo.session);
    request.headers = { "content-type": "multipart/form-data; boundary=----x", rsc: "1" };

    const ctx = await requireContext();

    expect(ctx.org.isDemo).toBe(true);
  });

  it("a referer from another site is not followed back", async () => {
    signInAs(demo.session);
    request.headers = { ...SAVING, host: "www.matlockone.com", referer: "https://evil.example/phish" };

    await expect(requireContext()).rejects.toThrow(/^NEXT_REDIRECT \/demo$/);
  });

  it("a real action stops before it writes anything", async () => {
    signInAs(demo.session);
    request.headers = SAVING;

    const form = new FormData();
    form.set("entityType", "client");
    form.set("entityId", demo.clientId);
    form.set("body", "Visitor was here");
    form.set("visibility", "INTERNAL");

    await expect(addNote(IDLE, form)).rejects.toThrow("NEXT_REDIRECT /demo");
    expect(await prisma.note.count({ where: { organizationId: demo.orgId } })).toBe(0);
  });

  it("an upload is refused before a single byte goes to storage", async () => {
    signInAs(demo.session);

    const response = await uploadTicket(
      new NextRequest("https://www.matlockone.com/api/files/upload-ticket", {
        method: "POST",
        body: JSON.stringify({
          entityType: "client",
          entityId: demo.clientId,
          fileName: "site.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1024,
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/This is a demo/);
  });
});

describe("a real business", () => {
  it("saves as it always did", async () => {
    signInAs(real.session);
    request.headers = SAVING;

    const ctx = await requireContext();

    expect(ctx.org.isDemo).toBe(false);
  });
});

describe("the demo's public links", () => {
  async function demoDocuments() {
    const invoice = await prisma.invoice.create({
      data: {
        organizationId: demo.orgId,
        clientId: demo.clientId,
        number: "INV-1001",
        status: "SENT",
        issueDate: new Date(),
        subtotalCents: 10_000,
        totalCents: 10_000,
        balanceCents: 10_000,
      },
    });
    const estimate = await prisma.estimate.create({
      data: {
        organizationId: demo.orgId,
        clientId: demo.clientId,
        number: "EST-1001",
        status: "SENT",
        issueDate: new Date(),
        subtotalCents: 10_000,
        totalCents: 10_000,
      },
    });
    return { invoice, estimate };
  }

  it("record nothing when opened", async () => {
    const { invoice } = await demoDocuments();

    await markInvoiceViewed(invoice.publicToken);

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("SENT");
    expect(after.viewedAt).toBeNull();
  });

  it("do not take an answer on a demo estimate", async () => {
    const { estimate } = await demoDocuments();

    const result = await respondToEstimate(estimate.publicToken, "ACCEPTED");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/demo estimate/);
    const after = await prisma.estimate.findUniqueOrThrow({ where: { id: estimate.id } });
    expect(after.status).toBe("SENT");
  });
});

describe("the morning automation run", () => {
  it("leaves the demo as it was seeded", async () => {
    const past = new Date();
    past.setDate(past.getDate() - 30);

    await prisma.invoice.create({
      data: {
        organizationId: demo.orgId,
        clientId: demo.clientId,
        number: "INV-1002",
        status: "SENT",
        issueDate: past,
        dueDate: past,
        subtotalCents: 10_000,
        totalCents: 10_000,
        balanceCents: 10_000,
      },
    });
    await prisma.workflow.create({
      data: { organizationId: demo.orgId, templateId: "overdue.chase", isActive: true },
    });

    await sweepEveryBusiness();

    expect(await prisma.task.count({ where: { organizationId: demo.orgId } })).toBe(0);
  });
});

describe("demoAvailable", () => {
  it("offers the demo only when it is the locked one", async () => {
    await prisma.user.deleteMany({ where: { email: DEMO_OWNER_EMAIL } });
    const unflagged = await prisma.organization.create({
      data: { slug: `unflagged-${randomUUID()}`, name: "Old seed", isDemo: false },
    });
    const owner = await prisma.user.create({
      data: {
        organizationId: unflagged.id,
        email: DEMO_OWNER_EMAIL,
        name: "Alex Rivera",
        passwordHash: "x",
        role: "OWNER",
      },
    });

    try {
      // A demo nobody guards must not be advertised to the public.
      expect(await demoAvailable()).toBe(false);

      await prisma.organization.update({ where: { id: unflagged.id }, data: { isDemo: true } });
      expect(await demoAvailable()).toBe(true);
    } finally {
      await prisma.user.delete({ where: { id: owner.id } });
    }
  });
});

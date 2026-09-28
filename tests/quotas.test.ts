import { randomUUID } from "node:crypto";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How much one business may keep, and how fast one person may save — the two
 * limits that stop one account filling the store or hammering the database
 * every business shares.
 *
 * Through the real guard, the real actions and route, and the test database;
 * the request is stood in for.
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

import { uploadAttachment } from "@/app/(app)/files/actions";
import SlowDownPage from "@/app/(app)/slow-down/page";
import { POST as uploadTicket } from "@/app/api/files/upload-ticket/route";
import { IDLE } from "@/lib/action-state";
import { requireContext } from "@/lib/auth";
import { entitlement, storageAllowance, type BillingFields } from "@/lib/billing/entitlement";
import { PLANS } from "@/lib/checkout/plans";
import { prisma } from "@/lib/db";
import { storageRoom, storageUsage, storageUsed } from "@/lib/quotas";
import { SAVES_PER_USER } from "@/lib/rate-limit";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { formatBytes } from "@/lib/storage-limits";

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

async function business(fields: Record<string, unknown> = {}) {
  const org = await prisma.organization.create({
    data: {
      slug: `quota-${randomUUID()}`,
      name: "Harbor Glass Co",
      subscriptionPlan: "starter",
      subscriptionStatus: "ACTIVE",
      paidThrough: new Date(Date.now() + 20 * DAY_MS),
      ...fields,
    },
  });
  const owner = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `owner-${randomUUID()}@example.test`,
      name: "Priya Nandakumar",
      passwordHash: "x",
      role: "OWNER",
    },
  });
  const client = await prisma.client.create({
    data: { organizationId: org.id, displayName: "Ines Carvalho", type: "PERSON" },
  });
  await createSession(owner.id);
  return { org, owner, clientId: client.id, session: request.cookies.get(SESSION_COOKIE)! };
}

/** Files already stored, as rows: the quota reads the rows, not the store. */
async function alreadyStored(organizationId: string, totalBytes: number) {
  const perFile = 15 * MB;
  const rows = [];
  for (let left = totalBytes; left > 0; left -= perFile) {
    rows.push({
      organizationId,
      fileName: `${randomUUID()}.jpg`,
      originalName: "site.jpg",
      mimeType: "image/jpeg",
      sizeBytes: Math.min(perFile, left),
      storagePath: `${organizationId}/${randomUUID()}.jpg`,
      kind: "PHOTO",
    });
  }
  await prisma.attachment.createMany({ data: rows });
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  // Hosted: files in a shared store, which is what the allowance protects.
  vi.stubEnv("STORAGE_PROVIDER", "s3");
  request.cookies.clear();
  request.headers = {};
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ----------------------------------------------------------- the allowance ---

describe("each plan's room for files", () => {
  const paid = (plan: string): BillingFields => ({
    isDemo: false,
    billingExempt: false,
    licenseKey: null,
    subscriptionStatus: "ACTIVE",
    subscriptionPlan: plan,
    paidThrough: new Date(Date.now() + DAY_MS),
  });

  it("is 10, 50 and 200 GB", () => {
    expect(storageAllowance(entitlement(paid("starter")))).toEqual({ bytes: 10 * GB, planName: "Starter" });
    expect(storageAllowance(entitlement(paid("business")))).toEqual({ bytes: 50 * GB, planName: "Business" });
    expect(storageAllowance(entitlement(paid("pro")))).toEqual({ bytes: 200 * GB, planName: "Pro" });
    expect(PLANS.business.storageLabel).toBe("50 GB of files and photos");
  });

  it("has no cap for an exempt business or the demo", () => {
    expect(storageAllowance(entitlement({ ...paid("starter"), billingExempt: true }))).toBeNull();
    expect(storageAllowance(entitlement({ ...paid("starter"), isDemo: true }))).toBeNull();
  });

  it("reads in gigabytes once it gets there", () => {
    expect(formatBytes(50 * GB)).toBe("50 GB");
    expect(formatBytes(1.25 * GB)).toBe("1.3 GB");
    expect(formatBytes(512 * MB)).toBe("512.0 MB");
  });
});

describe("counting what a business has stored", () => {
  it("adds up past 2 GB, where a 32-bit total would have wrapped", async () => {
    const { org } = await business();
    await alreadyStored(org.id, 3 * GB);

    expect(await storageUsed(org.id)).toBe(3 * GB);
  });

  it("counts only this business's files", async () => {
    const mine = await business();
    const theirs = await business();
    await alreadyStored(theirs.org.id, 40 * MB);

    expect(await storageUsed(mine.org.id)).toBe(0);
  });
});

describe("the room left", () => {
  it("takes files until the next one would go past the plan, then says why", async () => {
    const { org } = await business();
    await alreadyStored(org.id, 10 * GB - 20 * MB);
    const room = await storageRoom(org);

    expect(room.take(15 * MB)).toBeNull();
    // 5 MB left now; a batch stops at the file that would not fit.
    expect(room.take(10 * MB)).toBe(
      "That would go past the Starter plan’s 10 GB of files (10.0 GB used). Delete files you no longer need, or move to a larger plan under Billing.",
    );
    expect(room.take(4 * MB)).toBeNull();
  });

  it("has no cap for an exempt business", async () => {
    const { org } = await business({ billingExempt: true });
    await alreadyStored(org.id, 11 * GB);

    expect((await storageRoom(org)).take(15 * MB)).toBeNull();
  });

  it("has no cap on a desktop install that keeps files on its own disk", async () => {
    vi.stubEnv("STORAGE_PROVIDER", "local");
    const { org } = await business();
    await alreadyStored(org.id, 11 * GB);

    expect((await storageRoom(org)).take(15 * MB)).toBeNull();
    expect((await storageUsage(org)).allowance).toBeNull();
  });
});

describe("an upload with no room", () => {
  it("is turned away before the bytes are sent", async () => {
    const b = await business();
    await alreadyStored(b.org.id, 10 * GB - MB);
    request.cookies.set(SESSION_COOKIE, b.session);

    const response = await uploadTicket(
      new NextRequest("https://www.matlockone.com/api/files/upload-ticket", {
        method: "POST",
        body: JSON.stringify({
          entityType: "client",
          entityId: b.clientId,
          fileName: "site.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 5 * MB,
        }),
      }),
    );

    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/Starter plan’s 10 GB of files/);
  });

  it("is refused through the server too, and nothing is recorded", async () => {
    const b = await business();
    await alreadyStored(b.org.id, 10 * GB - MB);
    request.cookies.set(SESSION_COOKIE, b.session);
    request.headers = { "next-action": "up10ad" };
    const before = await prisma.attachment.count({ where: { organizationId: b.org.id } });

    const form = new FormData();
    form.set("entityType", "client");
    form.set("entityId", b.clientId);
    form.append("files", new File([new Uint8Array(2 * MB)], "site.jpg", { type: "image/jpeg" }));

    const result = await uploadAttachment(IDLE, form);

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toMatch(/Starter plan’s 10 GB of files/);
    expect(await prisma.attachment.count({ where: { organizationId: b.org.id } })).toBe(before);
  });
});

// ------------------------------------------------------------- save pace ---

describe("how fast one person may save", () => {
  const save = () => requireContext();

  it(`lets ${SAVES_PER_USER.limit} saves through, then pauses the next`, async () => {
    const b = await business();
    request.cookies.set(SESSION_COOKIE, b.session);
    request.headers = { "next-action": "5ave" };

    for (let n = 0; n < SAVES_PER_USER.limit; n++) await save();

    await expect(save()).rejects.toThrow(/NEXT_REDIRECT \/slow-down\?wait=\d+/);
  });

  it("never counts opening a page", async () => {
    const b = await business();
    request.cookies.set(SESSION_COOKIE, b.session);

    for (let n = 0; n < SAVES_PER_USER.limit + 5; n++) await requireContext();
  });

  it("counts each person separately, so a busy crew never adds up to it", async () => {
    const b = await business();
    const tech = await prisma.user.create({
      data: { organizationId: b.org.id, email: `tech-${randomUUID()}@example.test`, name: "Tomas", passwordHash: "x", role: "EMPLOYEE" },
    });
    await createSession(tech.id);
    const techSession = request.cookies.get(SESSION_COOKIE)!;
    request.headers = { "next-action": "5ave" };

    request.cookies.set(SESSION_COOKIE, b.session);
    for (let n = 0; n < SAVES_PER_USER.limit; n++) await save();
    await expect(save()).rejects.toThrow(/slow-down/);

    request.cookies.set(SESSION_COOKIE, techSession);
    expect((await save()).user.id).toBe(tech.id);
  });

  it("is not counted on a desktop install that keeps its own data", async () => {
    vi.stubEnv("STORAGE_PROVIDER", "local");
    const b = await business();
    request.cookies.set(SESSION_COOKIE, b.session);
    request.headers = { "next-action": "5ave" };

    for (let n = 0; n < SAVES_PER_USER.limit + 5; n++) await save();
  });

  it("says how long to wait, in words", async () => {
    const b = await business();
    request.cookies.set(SESSION_COOKIE, b.session);

    const html = renderToStaticMarkup(await SlowDownPage({ searchParams: Promise.resolve({ wait: "200" }) }));

    expect(html).toContain("That’s a lot of saving at once");
    expect(html).toContain(`more than ${SAVES_PER_USER.limit} times in 5 minutes`);
    expect(html).toContain("You can save again in 4 minutes.");
  });
});

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Banning and deleting a business from the Accounts page.
 *
 * Driven through the real sign-in action, session store and guard against
 * the test database, with only the request and PayPal stood in for. What is
 * pinned: a ban signs everyone out and keeps them out, closes the customer
 * links and stops the plan, and comes off again cleanly; a delete takes the
 * whole business with it and frees its emails, and refuses while PayPal
 * would go on charging; and neither touches the demo or the operator's own
 * business.
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

import { loginAction } from "@/app/(auth)/actions";
import { banBusiness, deleteBusiness, liftBan, type StopBilling } from "@/lib/account-bans";
import { standingOf } from "@/lib/accounts-overview";
import { BANNED_SIGN_IN, emailInUse, getContext } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { portalView } from "@/lib/portal";
import { SESSION_COOKIE } from "@/lib/session";

const PASSWORD = "Harbor-Glass-2026";
const DAY_MS = 24 * 60 * 60 * 1000;

/** A paying business with an owner and a customer who has a portal link. */
async function business(fields: Record<string, unknown> = {}) {
  const org = await prisma.organization.create({
    data: {
      slug: `ban-${randomUUID()}`,
      name: "Harbor Glass Co",
      subscriptionId: `I-${randomUUID()}`,
      subscriptionPlan: "business",
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
      passwordHash: await hashPassword(PASSWORD),
      role: "OWNER",
    },
  });
  const client = await prisma.client.create({
    data: { organizationId: org.id, displayName: "Dana Whitfield", portalToken: randomUUID() + randomUUID() },
  });
  return { org, owner, client };
}

/** The operator's own business, which is never a target. */
async function operatorBusiness() {
  return prisma.organization.create({
    data: { slug: `operator-${randomUUID()}`, name: "Matlock Software", billingExempt: true },
  });
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

/** Signs in as a fresh device would. */
async function signIn(email: string) {
  request.cookies.clear();
  try {
    const state = await loginAction({}, form({ email, password: PASSWORD, remember: "on" }));
    return { redirect: null, state, cookie: request.cookies.get(SESSION_COOKIE) ?? null };
  } catch (error) {
    const match = /^NEXT_REDIRECT (.+)$/.exec((error as Error).message);
    if (!match) throw error;
    return { redirect: match[1], state: null, cookie: request.cookies.get(SESSION_COOKIE) ?? null };
  }
}

async function whoIs(cookie: string | null) {
  request.cookies.clear();
  if (cookie) request.cookies.set(SESSION_COOKIE, cookie);
  return (await getContext())?.user.id ?? null;
}

let cancelled: string[];
const payPalAgrees: StopBilling = async (id) => {
  cancelled.push(id);
  return { ok: true };
};
const payPalRefuses: StopBilling = async () => ({ ok: false, error: "PayPal is down" });

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  request.cookies.clear();
  request.headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}` };
  cancelled = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("banning a business", () => {
  it("signs everyone out, keeps them out, and stops the plan", async () => {
    const operator = await operatorBusiness();
    const { org, owner } = await business();
    const signedIn = await signIn(owner.email);
    expect(await whoIs(signedIn.cookie)).toBe(owner.id);

    const result = await banBusiness({
      organizationId: org.id,
      operatorOrganizationId: operator.id,
      reason: "Sent spam to thousands of addresses",
      stopBilling: payPalAgrees,
    });

    expect(result).toEqual({ ok: true, billing: "stopped" });
    expect(cancelled).toEqual([org.subscriptionId]);
    expect(await whoIs(signedIn.cookie)).toBeNull();

    const again = await signIn(owner.email);
    expect(again.state?.error).toBe(BANNED_SIGN_IN);
    expect(again.cookie).toBeNull();

    const after = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(after.bannedAt).not.toBeNull();
    expect(after.banReason).toBe("Sent spam to thousands of addresses");
    expect(after.subscriptionStatus).toBe("CANCELLED");
    expect(standingOf(after)).toBe("banned");
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "account.banned" } })).toBe(1);
  });

  it("closes the links its customers were sent", async () => {
    const operator = await operatorBusiness();
    const { org, client } = await business();
    expect(await portalView(client.portalToken!)).not.toBeNull();

    await banBusiness({
      organizationId: org.id,
      operatorOrganizationId: operator.id,
      reason: "Fraud",
      stopBilling: payPalAgrees,
    });

    expect(await portalView(client.portalToken!)).toBeNull();
  });

  it("still bans when PayPal will not cancel, and says which plan to cancel by hand", async () => {
    const operator = await operatorBusiness();
    const { org } = await business();

    const result = await banBusiness({
      organizationId: org.id,
      operatorOrganizationId: operator.id,
      reason: "Abuse",
      stopBilling: payPalRefuses,
    });

    expect(result).toEqual({
      ok: true,
      billing: { error: "PayPal is down", subscriptionId: org.subscriptionId },
    });
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(after.bannedAt).not.toBeNull();
    expect(after.subscriptionStatus).toBe("ACTIVE");
  });

  it("asks for a reason, and never touches the demo or the operator's own business", async () => {
    const operator = await operatorBusiness();
    const { org } = await business();
    const demo = await prisma.organization.create({
      data: { slug: `demo-${randomUUID()}`, name: "Demo", isDemo: true },
    });
    const ban = (organizationId: string, reason = "Abuse") =>
      banBusiness({ organizationId, operatorOrganizationId: operator.id, reason, stopBilling: payPalAgrees });

    expect(await ban(org.id, "   ")).toMatchObject({ ok: false });
    expect(await ban(demo.id)).toMatchObject({ ok: false });
    expect(await ban(operator.id)).toMatchObject({ ok: false });
    expect(cancelled).toEqual([]);

    const untouched = await prisma.organization.findMany({
      where: { id: { in: [org.id, demo.id, operator.id] } },
    });
    expect(untouched.every((each) => each.bannedAt === null)).toBe(true);
  });

  it("comes off again, and the same people can sign back in", async () => {
    const operator = await operatorBusiness();
    const { org, owner } = await business();
    await banBusiness({
      organizationId: org.id,
      operatorOrganizationId: operator.id,
      reason: "Mistaken",
      stopBilling: payPalAgrees,
    });

    expect(await liftBan({ organizationId: org.id, operatorOrganizationId: operator.id })).toEqual({ ok: true });

    const after = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(after.bannedAt).toBeNull();
    expect(after.banReason).toBeNull();
    const signedIn = await signIn(owner.email);
    expect(signedIn.redirect).toBe("/dashboard");
    expect(await whoIs(signedIn.cookie)).toBe(owner.id);
  });
});

describe("deleting a business", () => {
  it("takes everything with it and frees its emails", async () => {
    const operator = await operatorBusiness();
    const { org, owner, client } = await business();
    await signIn(owner.email);
    await prisma.attachment.create({
      data: {
        organizationId: org.id,
        fileName: "photo.jpg",
        originalName: "photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        storagePath: `${org.id}/${randomUUID()}.jpg`,
      },
    });

    const result = await deleteBusiness({
      organizationId: org.id,
      operatorOrganizationId: operator.id,
      stopBilling: payPalAgrees,
    });

    expect(result).toEqual({ ok: true, name: "Harbor Glass Co", autopayLeft: 0, filesLeft: 0 });
    expect(cancelled).toEqual([org.subscriptionId]);
    expect(await prisma.organization.findUnique({ where: { id: org.id } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: owner.id } })).toBeNull();
    expect(await prisma.client.findUnique({ where: { id: client.id } })).toBeNull();
    expect(await prisma.session.count({ where: { userId: owner.id } })).toBe(0);
    expect(await prisma.attachment.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await emailInUse(owner.email, null)).toBeNull();
  });

  it("deletes nothing while PayPal would go on charging", async () => {
    const operator = await operatorBusiness();
    const { org } = await business();

    const result = await deleteBusiness({
      organizationId: org.id,
      operatorOrganizationId: operator.id,
      stopBilling: payPalRefuses,
    });

    expect(result).toMatchObject({ ok: false });
    expect(await prisma.organization.findUnique({ where: { id: org.id } })).not.toBeNull();
  });

  it("needs no PayPal for a business with no live plan", async () => {
    const operator = await operatorBusiness();
    const { org } = await business({ subscriptionId: null, subscriptionStatus: null, paidThrough: null });

    const result = await deleteBusiness({
      organizationId: org.id,
      operatorOrganizationId: operator.id,
      stopBilling: payPalRefuses,
    });

    expect(result).toMatchObject({ ok: true });
  });

  it("never deletes the demo or the operator's own business", async () => {
    const operator = await operatorBusiness();
    const demo = await prisma.organization.create({
      data: { slug: `demo-${randomUUID()}`, name: "Demo", isDemo: true },
    });

    for (const id of [demo.id, operator.id]) {
      const result = await deleteBusiness({
        organizationId: id,
        operatorOrganizationId: operator.id,
        stopBilling: payPalAgrees,
      });
      expect(result).toMatchObject({ ok: false });
      expect(await prisma.organization.findUnique({ where: { id } })).not.toBeNull();
    }
  });
});

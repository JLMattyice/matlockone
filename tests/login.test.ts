import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Signing in, from anywhere.
 *
 * Driven through the real sign-in action, the real session store and the
 * real guard, against the test database; only the request is stood in for.
 * What is pinned is what goes wrong in practice on phones and second
 * computers: a keyboard that capitalises the first letter or leaves a space,
 * a person signed in on two devices at once, an address in ?next= that
 * leaves the site, and one email held by two accounts.
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

import { loginAction, logoutAction } from "@/app/(auth)/actions";
import { GET as sessionExpired } from "@/app/session-expired/route";
import { updateOwnProfile } from "@/app/(app)/settings/actions";
import { createTeamMember, updateTeamMember } from "@/app/(app)/team/actions";
import { IDLE } from "@/lib/action-state";
import { getContext, safeNextPath } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { SESSION_COOKIE } from "@/lib/session";

const PASSWORD = "Harbor-Glass-2026";
const DAY_MS = 24 * 60 * 60 * 1000;

async function business(name = "Harbor Glass Co") {
  const org = await prisma.organization.create({
    data: {
      slug: `login-${randomUUID()}`,
      name,
      subscriptionPlan: "business",
      subscriptionStatus: "ACTIVE",
      paidThrough: new Date(Date.now() + 20 * DAY_MS),
    },
  });
  return org.id;
}

async function person(
  organizationId: string,
  fields: { email?: string; password?: string; role?: string; isActive?: boolean } = {},
) {
  return prisma.user.create({
    data: {
      organizationId,
      email: fields.email ?? `owner-${randomUUID()}@example.test`,
      name: "Priya Nandakumar",
      passwordHash: await hashPassword(fields.password ?? PASSWORD),
      role: fields.role ?? "OWNER",
      isActive: fields.isActive ?? true,
    },
  });
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

/** Signs in as a fresh device would: no cookie, its own address. */
async function signIn(email: string, password: string, extra: Record<string, string> = {}) {
  request.cookies.clear();
  try {
    const state = await loginAction({}, form({ email, password, remember: "on", ...extra }));
    return { redirect: null, state, cookie: request.cookies.get(SESSION_COOKIE) ?? null };
  } catch (error) {
    const match = /^NEXT_REDIRECT (.+)$/.exec((error as Error).message);
    if (!match) throw error;
    return { redirect: match[1], state: null, cookie: request.cookies.get(SESSION_COOKIE) ?? null };
  }
}

/** Who a device's cookie signs in as, or null. */
async function whoIs(cookie: string | null) {
  request.cookies.clear();
  if (cookie) request.cookies.set(SESSION_COOKIE, cookie);
  return (await getContext())?.user.id ?? null;
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  request.cookies.clear();
  // Each test from its own address, so the per-address limit is never what
  // a test is measuring by accident.
  request.headers = { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250) + 1}` };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ------------------------------------------------------------- the basics ---

describe("signing in", () => {
  it("opens the account and lands on the dashboard", async () => {
    const owner = await person(await business());

    const result = await signIn(owner.email, PASSWORD);

    expect(result.redirect).toBe("/dashboard");
    expect(await whoIs(result.cookie)).toBe(owner.id);
  });

  it("does not mind the capital letter and the space a phone keyboard adds", async () => {
    const owner = await person(await business(), { email: `lane-${randomUUID()}@example.test` });
    const typed = `  ${owner.email[0].toUpperCase()}${owner.email.slice(1).replace("example", "Example")} `;

    const result = await signIn(typed, PASSWORD);

    expect(result.redirect).toBe("/dashboard");
    expect(await whoIs(result.cookie)).toBe(owner.id);
  });

  it("refuses a wrong password without saying whether the email exists, and keeps what was typed", async () => {
    const owner = await person(await business());

    const wrong = await signIn(owner.email, "not-the-password");
    const unknown = await signIn(`nobody-${randomUUID()}@example.test`, PASSWORD);

    expect(wrong.state?.error).toBe("That email and password combination did not match.");
    expect(unknown.state?.error).toBe(wrong.state?.error);
    expect(wrong.state?.values?.email).toBe(owner.email);
    expect(wrong.cookie).toBeNull();
  });

  it("tells a deactivated person why, rather than blaming their password", async () => {
    const gone = await person(await business(), { role: "EMPLOYEE", isActive: false });

    const result = await signIn(gone.email, PASSWORD);

    expect(result.state?.error).toMatch(/deactivated/);
    expect(result.cookie).toBeNull();
  });

  it("counts attempts on one email once, however it is capitalised", async () => {
    const owner = await person(await business(), { email: `count-${randomUUID()}@example.test` });

    for (let n = 0; n < 10; n++) {
      const typed = n % 2 ? owner.email.toUpperCase() : owner.email;
      await signIn(typed, "wrong-guess");
    }
    // The eleventh, even with the right password, waits out the window.
    const refused = await signIn(owner.email, PASSWORD);

    expect(refused.state?.error).toMatch(/Too many sign-in attempts/);
  });
});

// ------------------------------------------------------- several devices ---

describe("on more than one device", () => {
  it("keeps every device signed in at once, each on its own session", async () => {
    const owner = await person(await business());

    const office = await signIn(owner.email, PASSWORD);
    const phone = await signIn(owner.email, PASSWORD);
    const laptop = await signIn(owner.email, PASSWORD);

    expect(new Set([office.cookie, phone.cookie, laptop.cookie]).size).toBe(3);
    for (const device of [office, phone, laptop]) expect(await whoIs(device.cookie)).toBe(owner.id);
  });

  it("signs out only the device that signs out", async () => {
    const owner = await person(await business());
    const office = await signIn(owner.email, PASSWORD);
    const phone = await signIn(owner.email, PASSWORD);

    request.cookies.clear();
    request.cookies.set(SESSION_COOKIE, phone.cookie!);
    await expect(logoutAction()).rejects.toThrow("NEXT_REDIRECT");

    expect(await whoIs(phone.cookie)).toBeNull();
    expect(await whoIs(office.cookie)).toBe(owner.id);
  });

  it("lets a teammate sign in to the same business from their own phone", async () => {
    const orgId = await business();
    const owner = await person(orgId);
    const tech = await person(orgId, { role: "EMPLOYEE" });

    const ownerDevice = await signIn(owner.email, PASSWORD);
    const techPhone = await signIn(tech.email, PASSWORD);

    expect(await whoIs(ownerDevice.cookie)).toBe(owner.id);
    expect(await whoIs(techPhone.cookie)).toBe(tech.id);
  });
});

// ------------------------------------------------------------ after sign-in ---

describe("where sign-in sends you", () => {
  it("back to the page that asked for it", async () => {
    const owner = await person(await business());

    const result = await signIn(owner.email, PASSWORD, { next: "/invoices?status=overdue" });

    expect(result.redirect).toBe("/invoices?status=overdue");
  });

  it("never to another site, however the address is dressed up", async () => {
    const owner = await person(await business());

    for (const next of [
      "https://evil.example/login",
      "//evil.example",
      "/\\evil.example",
      "/\\/evil.example",
      "/%5Cevil.example",
      "/\tevil.example",
      "javascript:alert(1)",
    ]) {
      const result = await signIn(owner.email, PASSWORD, { next });
      // Resolved the way a browser resolves a Location header, backslashes
      // included: it has to stay on this site.
      const landed = new URL(result.redirect!.replace(/\\/g, "/"), "https://www.matlockone.com");
      expect(landed.origin, next).toBe("https://www.matlockone.com");
      expect(result.redirect, next).not.toMatch(/^\/\/|\\|javascript:/);
    }
  });

  it("safeNextPath keeps paths on this site and nothing else", () => {
    expect(safeNextPath("/jobs/abc#notes")).toBe("/jobs/abc#notes");
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath("/\\evil.example")).toBe("/dashboard");
    expect(safeNextPath("//evil.example")).toBe("/dashboard");
    expect(safeNextPath("/ok\u0000")).toBe("/dashboard");
  });
});

// ---------------------------------------------------- one email, one account ---

describe("one email, one account", () => {
  const blank = { phone: "", position: "", hourlyRate: "" };

  it("will not add a teammate whose email already signs in to another business", async () => {
    const theirOwn = await person(await business("Reyes Electric"), { email: `tomas-${randomUUID()}@example.test` });
    const orgId = await business();
    const owner = await person(orgId);
    request.cookies.set(SESSION_COOKIE, (await signIn(owner.email, PASSWORD)).cookie!);
    request.headers = { ...request.headers, "next-action": "t3am" };

    const result = await createTeamMember(
      IDLE,
      form({ name: "Tomas Reyes", email: theirOwn.email.toUpperCase(), role: "EMPLOYEE", password: "Another-pass-99", ...blank }),
    );

    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { email: "That email already signs in to another Matlock One account. Use a different one." },
    });
    expect(await prisma.user.count({ where: { email: theirOwn.email } })).toBe(1);
  });

  it("still says 'your team' when the clash is on the same team", async () => {
    const orgId = await business();
    const owner = await person(orgId);
    const tech = await person(orgId, { role: "EMPLOYEE" });
    request.cookies.set(SESSION_COOKIE, (await signIn(owner.email, PASSWORD)).cookie!);
    request.headers = { ...request.headers, "next-action": "t3am" };

    const result = await createTeamMember(
      IDLE,
      form({ name: "Second Tech", email: tech.email, role: "EMPLOYEE", password: "Another-pass-99", ...blank }),
    );

    expect(result).toMatchObject({ fieldErrors: { email: "Someone on your team already uses that email." } });
  });

  it("will not move a teammate, or yourself, onto an email another account uses", async () => {
    const elsewhere = await person(await business("Reyes Electric"));
    const orgId = await business();
    const owner = await person(orgId);
    const tech = await person(orgId, { role: "EMPLOYEE" });
    request.cookies.set(SESSION_COOKIE, (await signIn(owner.email, PASSWORD)).cookie!);
    request.headers = { ...request.headers, "next-action": "t3am" };

    const teammate = await updateTeamMember(
      IDLE,
      form({ id: tech.id, name: "Tomas Reyes", email: elsewhere.email, role: "EMPLOYEE", ...blank }),
    );
    const own = await updateOwnProfile(IDLE, form({ name: "Priya Nandakumar", email: elsewhere.email, phone: "", position: "" }));

    expect(teammate).toMatchObject({ ok: false });
    expect(own).toMatchObject({ ok: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: tech.id } })).email).toBe(tech.email);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).email).toBe(owner.email);
  });

  it("still signs each account in where an email was already shared before this", async () => {
    // Two accounts on one email, from before every save checked. Each
    // password opens its own business — neither is locked out.
    const shared = `shared-${randomUUID()}@example.test`;
    const first = await person(await business("Reyes Electric"), { email: shared, password: "Reyes-own-pass-1" });
    const second = await person(await business(), { email: shared, password: "Harbor-team-pass-2", role: "EMPLOYEE" });

    const one = await signIn(shared, "Reyes-own-pass-1");
    const two = await signIn(shared, "Harbor-team-pass-2");

    expect(await whoIs(one.cookie)).toBe(first.id);
    expect(await whoIs(two.cookie)).toBe(second.id);
  });
});

// ------------------------------------------------------ an expired sign-in ---

describe("coming back to an expired sign-in", () => {
  it("clears the old cookie and sends the browser to sign in on the address it used", async () => {
    // A phone on the office network reaching a desktop install: the server
    // thinks of itself as localhost, the phone knows it by its network address.
    const response = await sessionExpired(
      new NextRequest("http://localhost:3100/session-expired?next=%2Fjobs", {
        headers: { host: "192.168.1.50:3100", cookie: `${SESSION_COOKIE}=stale` },
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/login?next=%2Fjobs");
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Expires=Thu, 01 Jan 1970`));
  });

  it("goes to plain sign-in when there was no page to return to", async () => {
    const response = await sessionExpired(new NextRequest("http://localhost:3100/session-expired"));

    expect(response.headers.get("location")).toBe("/login");
  });
});


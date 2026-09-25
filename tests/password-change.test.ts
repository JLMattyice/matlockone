import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Changing your own password.
 *
 * Two things were wrong. Nothing limited how fast a signed-in session could
 * test the current password, so a stolen session could guess its way to a new
 * one and lock the owner out. And a successful change signed out the device it
 * was made on, while telling the person that only other devices had been.
 *
 * Driven through the real action and the real session store, with only the
 * request — the signed-in user, and the cookie jar — stood in for.
 */

const request = vi.hoisted(() => ({
  user: null as unknown as Record<string, unknown>,
  org: null as unknown as Record<string, unknown>,
  cookies: new Map<string, string>(),
}));

vi.mock("@/lib/auth", () => ({
  requireContext: async () => request,
  requirePermission: async () => request,
  getContext: async () => request,
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.20" }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { changeOwnPassword } from "@/app/(app)/settings/actions";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { PASSWORD_CHECK_PER_USER } from "@/lib/rate-limit";
import { createSession, resolveSession, SESSION_COOKIE } from "@/lib/session";

const OLD = "Old-passw0rd-2019";
const NEW = "Brand-new-Passw0rd-2026";

let userId: string;

const attempt = (current: string, next = NEW) => {
  const form = new FormData();
  form.set("currentPassword", current);
  form.set("newPassword", next);
  form.set("confirmPassword", next);
  return changeOwnPassword(IDLE, form);
};

const storedHash = async () =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } }))
    .passwordHash;

beforeEach(async () => {
  const org = await prisma.organization.create({
    data: { slug: `password-${randomUUID()}`, name: "Password Test Co" },
  });
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `pat-${randomUUID()}@example.test`,
      name: "Pat Moreno",
      passwordHash: await hashPassword(OLD),
      role: "OWNER",
    },
  });
  userId = user.id;
  request.user = user;
  request.org = org;
  request.cookies.clear();
});

describe("checking the current password", () => {
  it("allows a few wrong guesses, each told plainly", async () => {
    for (let i = 0; i < PASSWORD_CHECK_PER_USER.limit; i++) {
      const result = await attempt("not-it");
      expect(result.fieldErrors?.currentPassword).toBe("That is not your current password.");
    }
  });

  it("stops after five, and then refuses even the right password", async () => {
    for (let i = 0; i < PASSWORD_CHECK_PER_USER.limit; i++) await attempt("not-it");

    // The right answer, too late. Refusing it is the point: otherwise the
    // limit tells a guesser nothing, and still lets them in.
    const result = await attempt(OLD);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Too many attempts at your current password\. Try again in/);
    expect(await verifyPassword(OLD, await storedHash())).toBe(true);
  });

  it("starts the count again after the right password", async () => {
    for (let i = 0; i < PASSWORD_CHECK_PER_USER.limit - 1; i++) await attempt("not-it");
    expect((await attempt(OLD)).ok).toBe(true);

    // Whoever that was knew the password. Their next mistakes start from zero.
    for (let i = 0; i < PASSWORD_CHECK_PER_USER.limit; i++) {
      expect((await attempt("not-it")).fieldErrors?.currentPassword).toBeDefined();
    }
  });

  it("does not count a change that never reached the check", async () => {
    // A confirmation that does not match tests nothing about the password.
    for (let i = 0; i < PASSWORD_CHECK_PER_USER.limit + 3; i++) {
      const form = new FormData();
      form.set("currentPassword", "not-it");
      form.set("newPassword", NEW);
      form.set("confirmPassword", "something else");
      await changeOwnPassword(IDLE, form);
    }

    expect((await attempt(OLD)).ok).toBe(true);
  });
});

describe("a successful change", () => {
  // Session tokens are stored as keyed hashes, and the key is this.
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("signs out other devices and keeps this one", async () => {
    // Two devices signed in. createSession sets the cookie on the request, so
    // the second one made is the device doing the changing.
    await createSession(userId);
    const otherDevice = request.cookies.get(SESSION_COOKIE)!;
    await createSession(userId);
    const thisDevice = request.cookies.get(SESSION_COOKIE)!;
    expect(otherDevice).not.toBe(thisDevice);

    const result = await attempt(OLD);

    expect(result).toMatchObject({
      ok: true,
      message: "Password changed. Other devices have been signed out.",
    });
    expect(await resolveSession(thisDevice)).not.toBeNull();
    expect(await resolveSession(otherDevice)).toBeNull();
    expect(await verifyPassword(NEW, await storedHash())).toBe(true);
  });
});

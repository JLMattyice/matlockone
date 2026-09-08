import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { prisma } from "./db";
import { asStatus, ROLES, type Role } from "./constants";
import { verifyPassword } from "./password";
import { can, type Permission, PermissionError } from "./permissions";
import { createSession, destroySession, readSessionToken, resolveSession } from "./session";
import type { Organization } from "@/generated/prisma/client";

export type SessionUser = {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  phone: string | null;
  avatarUrl: string | null;
  role: Role;
  position: string | null;
};

export type AppContext = {
  user: SessionUser;
  org: Organization;
};

/**
 * Resolved once per request. Every server component and action reads the actor
 * from here rather than trusting anything the client sends.
 */
export const getContext = cache(async (): Promise<AppContext | null> => {
  const token = await readSessionToken();
  if (!token) return null;

  const session = await resolveSession(token);
  if (!session) return null;

  const { user } = session;

  return {
    user: {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      name: user.name,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      role: asStatus(ROLES, user.role, "EMPLOYEE") as Role,
      position: user.position,
    },
    org: user.organization,
  };
});

/**
 * Redirects to the login screen when signed out.
 *
 * The hop goes through /session-expired rather than straight to /login: a
 * cookie may still be present for a session that no longer resolves, and only
 * a route handler can clear it. Going direct would loop against middleware.
 */
export async function requireContext(): Promise<AppContext> {
  const ctx = await getContext();
  if (!ctx) redirect("/session-expired");
  return ctx;
}

/**
 * Page-level guard: redirects signed-out users to login, and users whose role
 * lacks `permission` to an explanatory screen.
 *
 * A redirect rather than a thrown error, because a client error boundary only
 * receives an opaque digest in production and could not distinguish "you are
 * not allowed here" from "the server crashed". Server *actions* still use
 * `assertCan`, where throwing is the right behaviour.
 */
export async function requirePermission(
  permission: Permission,
): Promise<AppContext> {
  const ctx = await requireContext();
  if (!can(ctx.user, permission)) redirect("/no-access");
  return ctx;
}

export async function currentUserCan(permission: Permission) {
  const ctx = await getContext();
  return can(ctx?.user, permission);
}

// ------------------------------------------------------------- login flow ---

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; error: string };

/**
 * Verifies credentials and opens a session.
 *
 * The same message is returned for an unknown email and a wrong password, and a
 * hash is verified either way, so the response does not reveal which accounts
 * exist or leak timing differences.
 */
export async function login(
  emailRaw: string,
  password: string,
  options: { remember?: boolean } = {},
): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase();
  const GENERIC = "That email and password combination did not match.";

  if (!email || !password) return { ok: false, error: GENERIC };

  const user = await prisma.user.findFirst({
    where: { email },
    include: { organization: true },
  });

  // Dummy hash keeps the unknown-email path as slow as the wrong-password path.
  const storedHash =
    user?.passwordHash ??
    "scrypt$16384$8$1$00000000000000000000000000000000$" + "0".repeat(128);

  const passwordOk = await verifyPassword(password, storedHash);

  if (!user || !passwordOk) return { ok: false, error: GENERIC };
  if (!user.isActive) {
    return {
      ok: false,
      error: "This account has been deactivated. Ask an administrator to restore it.",
    };
  }

  const headerList = await headers();
  await createSession(user.id, {
    remember: options.remember ?? true,
    userAgent: headerList.get("user-agent"),
    ipAddress:
      headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return {
    ok: true,
    user: {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      name: user.name,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      role: asStatus(ROLES, user.role, "EMPLOYEE") as Role,
      position: user.position,
    },
  };
}

export async function logout() {
  await destroySession();
}

export { PermissionError };

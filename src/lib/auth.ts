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

  // The demo business can be looked at and not changed. Checked here, where
  // every page and every action begins, rather than action by action: a single
  // action that forgot would be a way for a stranger to create records in the
  // demo, or send real email from it.
  if (ctx.org.isDemo && (await isSubmission())) {
    redirect(`${DEMO_REFUSED_PATH}${await backPath()}`);
  }

  return ctx;
}

/** Where a demo visitor lands after trying to save. */
export const DEMO_REFUSED_PATH = "/demo";

/**
 * Whether this request is sending something rather than asking for a page.
 *
 * A server action from the running app carries a Next-Action header. The same
 * form posted with JavaScript off arrives without one, as an ordinary form
 * body, and still runs its action — its content type gives it away. A page,
 * and the router's fetch of one, has neither.
 */
async function isSubmission(): Promise<boolean> {
  try {
    const request = await headers();
    if (request.get("next-action")) return true;

    // An action that redirects has its destination drawn by Next itself, in a
    // GET that forwards the original request's headers — the form's content
    // type included — with an RSC header added. That is a page being drawn,
    // not a save, and refusing it again blanks the page the visitor was sent
    // to. A form posted with JavaScript off never carries the RSC header.
    if (request.get("rsc")) return false;

    const type = request.get("content-type") ?? "";
    return (
      type.startsWith("multipart/form-data") ||
      type.startsWith("application/x-www-form-urlencoded")
    );
  } catch {
    // Outside a request — a script, a scheduled run — nothing is being sent.
    return false;
  }
}

/**
 * The page the refused save came from, as ?back= for the demo page's "keep
 * looking around". Only ever a path on this site: the referer is the
 * browser's to set, and an address somewhere else is dropped.
 */
async function backPath(): Promise<string> {
  try {
    const request = await headers();
    const referer = request.get("referer");
    const host = request.get("host");
    if (!referer || !host) return "";

    const from = new URL(referer);
    if (from.host !== host) return "";

    const path = `${from.pathname}${from.search}`;
    if (!path.startsWith("/") || path.startsWith("//") || path.startsWith(DEMO_REFUSED_PATH)) {
      return "";
    }
    return `?back=${encodeURIComponent(path)}`;
  } catch {
    return "";
  }
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

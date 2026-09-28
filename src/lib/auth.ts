import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { BILLING_PATH, entitlement } from "./billing/entitlement";
import { dataStaysOnThisMachine } from "./config";
import { prisma } from "./db";
import { asStatus, ROLES, type Role } from "./constants";
import { verifyPassword } from "./password";
import { can, type Permission, PermissionError } from "./permissions";
import { hit, SAVES_PER_USER } from "./rate-limit";
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
export type ContextOptions = {
  /**
   * "allow" for the few places a business that has not paid must still reach:
   * the billing screen and the actions on it, which are how it pays. Every
   * other page and action leaves this out, and is closed to it.
   */
  unpaid?: "allow";
};

export async function requireContext(options: ContextOptions = {}): Promise<AppContext> {
  const ctx = await getContext();
  if (!ctx) redirect("/session-expired");

  // The demo business can be looked at and not changed. Checked here, where
  // every page and every action begins, rather than action by action: a single
  // action that forgot would be a way for a stranger to create records in the
  // demo, or send real email from it.
  const submitting = await isSubmission();
  if (ctx.org.isDemo && submitting) {
    redirect(`${DEMO_REFUSED_PATH}${await backPath()}`);
  }

  // No free tier: a business that has not paid, or whose payment has run out,
  // sees the billing screen and nothing else. Here for the same reason as the
  // demo check — one place, so no page or action can be the one that forgot.
  if (options.unpaid !== "allow" && !entitlement(ctx.org).ok) redirect(BILLING_PATH);

  // How fast one person may save, for the same reason again: in one place,
  // every save is counted. Not on a desktop install that keeps its own data,
  // which shares its database with nobody.
  if (submitting && !dataStaysOnThisMachine()) {
    const wait = await saveLimitWait(ctx.user.id);
    if (wait !== null) redirect(`${SLOW_DOWN_PATH}?wait=${wait}`);
  }

  return ctx;
}

/** Where somebody lands after saving faster than SAVES_PER_USER allows. */
export const SLOW_DOWN_PATH = "/slow-down";

/**
 * Seconds until this person may save again, or null if they may now. Fails
 * open: the limit being unreadable is no reason to refuse a real save.
 */
async function saveLimitWait(userId: string): Promise<number | null> {
  try {
    const verdict = await hit(`saves:user:${userId}`, SAVES_PER_USER);
    return verdict.ok ? null : verdict.retryAfterSeconds;
  } catch {
    return null;
  }
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
  options: ContextOptions = {},
): Promise<AppContext> {
  const ctx = await requireContext(options);
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
 *
 * An email belongs to one account — every place that saves one checks
 * emailInUse() — but that was not always so: adding a team member once
 * checked only that business's own team. So an email held by more than one
 * account is still handled, by trying the password against each, active and
 * most recently used first. Taking whichever row came back first would lock
 * the person out of all but one of them.
 */
export async function login(
  emailRaw: string,
  password: string,
  options: { remember?: boolean } = {},
): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase();
  const GENERIC = "That email and password combination did not match.";

  if (!email || !password) return { ok: false, error: GENERIC };

  const candidates = await prisma.user.findMany({
    where: { email },
    orderBy: [{ isActive: "desc" }, { lastLoginAt: { sort: "desc", nulls: "last" } }],
  });

  let user: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (await verifyPassword(password, candidate.passwordHash)) {
      user = candidate;
      break;
    }
  }

  // Dummy hash keeps the unknown-email path as slow as the wrong-password path.
  if (candidates.length === 0) {
    await verifyPassword(
      password,
      "scrypt$16384$8$1$00000000000000000000000000000000$" + "0".repeat(128),
    );
  }

  if (!user) return { ok: false, error: GENERIC };
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

/**
 * Whether an email already signs somebody in, other than `exceptUserId`.
 *
 * Sign-in looks an email up across every business, so it can belong to one
 * account only. Checked wherever an email is saved — sign-up, adding or
 * editing a team member, changing your own — and answered as "team" or
 * "elsewhere" so the message can say which.
 */
export async function emailInUse(
  email: string,
  organizationId: string | null,
  exceptUserId?: string,
): Promise<"team" | "elsewhere" | null> {
  const holder = await prisma.user.findFirst({
    where: { email, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
    select: { organizationId: true },
  });
  if (!holder) return null;
  return holder.organizationId === organizationId ? "team" : "elsewhere";
}

export const EMAIL_IN_USE = {
  team: "Someone on your team already uses that email.",
  elsewhere: "That email already signs in to another Matlock One account. Use a different one.",
} as const;

/**
 * Where to send somebody after they sign in: a path on this site, or the
 * dashboard.
 *
 * The path arrives in the address (?next=), so anybody can write one. A
 * leading "/" is not enough: "//evil.example" is another site, and so is
 * "/\evil.example", because browsers read a backslash in an address as a
 * slash. So the path is resolved against a stand-in origin and kept only if
 * it stays there.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;

  try {
    const base = "https://matlockone.invalid";
    const url = new URL(next, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export { PermissionError };

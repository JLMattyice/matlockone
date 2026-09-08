import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import { prisma } from "./db";
import { SESSION_COOKIE } from "./session-cookie";

export { SESSION_COOKIE };

/**
 * How long a session stays valid.
 *
 * "Stay signed in" is worth spelling out, because two different clocks are at
 * work and only one of them is a security boundary:
 *
 *  - The *database row* is the authority. A remembered session is good for
 *    thirty days, and every day of use pushes that thirty days forward, so
 *    somebody who opens the app most weeks never sees the sign-in screen
 *    again. Stop using it for a month and it lapses on its own.
 *  - The *cookie* is only a carrier for the token. It is given a deliberately
 *    long life so it outlives the row it points at; letting it expire first
 *    would sign people out on a fixed schedule no matter how often they came
 *    back, which is the behaviour this replaces.
 *
 * Without "stay signed in" the cookie has no expiry at all, which makes it a
 * session cookie: it dies when the app closes. That matters on the shared
 * computer in an office, where the server-side window is short as well, so a
 * stolen token is worth little even if the machine is left running.
 */
const REMEMBERED_DAYS = 30;
const PLAIN_HOURS = 12;

/** Chrome caps persistent cookies at 400 days and silently trims longer ones. */
const COOKIE_DAYS = 400;

/**
 * Sliding renewal is rate-limited: a session is only pushed forward once its
 * expiry has drifted a day from full. Otherwise every page view would write to
 * the database to move the deadline by a few seconds.
 */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error(
      "SESSION_SECRET must be set to at least 16 characters. See .env.example.",
    );
  }
  return value;
}

/**
 * The cookie carries the raw token; the database stores only its HMAC. A leaked
 * database backup therefore contains no usable session credentials.
 */
function fingerprint(token: string) {
  return createHmac("sha256", secret()).update(token).digest("hex");
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export type SessionOptions = {
  /** Whether the person ticked "keep me signed in". */
  remember?: boolean;
  userAgent?: string | null;
  ipAddress?: string | null;
};

export async function createSession(
  userId: string,
  meta: SessionOptions = {},
) {
  const remember = meta.remember ?? true;
  const token = newSessionToken();
  const expiresAt = new Date(
    Date.now() +
      (remember ? REMEMBERED_DAYS * DAY_MS : PLAIN_HOURS * 60 * 60 * 1000),
  );

  await prisma.session.create({
    data: {
      token: fingerprint(token),
      userId,
      expiresAt,
      remembered: remember,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      ipAddress: meta.ipAddress ?? null,
    },
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // No expiry when the answer was no: the cookie then lasts exactly as long
    // as the window stays open.
    ...(remember ? { expires: new Date(Date.now() + COOKIE_DAYS * DAY_MS) } : {}),
  });

  return { token, expiresAt, remember };
}

export async function readSessionToken() {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * How far in the future a remembered session should now expire, or null when
 * it is close enough to full that rewriting the row would be noise.
 *
 * Sessions predating the column read back as null, and were all created under
 * the old fixed thirty-day rule — treating them as remembered keeps anyone who
 * is already signed in signed in.
 */
export function renewedExpiry(
  session: { expiresAt: Date; remembered: boolean | null },
  now = Date.now(),
): Date | null {
  if (session.remembered === false) return null;

  const full = REMEMBERED_DAYS * DAY_MS;
  const remaining = session.expiresAt.getTime() - now;
  if (full - remaining < RENEW_AFTER_MS) return null;

  return new Date(now + full);
}

/**
 * Resolves the cookie to a live session row, deleting it once expired.
 *
 * A remembered session is also pushed forward here, which is why the renewal
 * touches only the database and never the cookie: this runs during ordinary
 * page renders, and Next.js allows cookies to be written only from a server
 * action or a route handler.
 */
export async function resolveSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { token: fingerprint(token) },
    include: { user: { include: { organization: true } } },
  });

  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  if (!session.user.isActive) return null;

  const renewed = renewedExpiry(session);
  if (renewed) {
    // Best effort. A busy database is not a reason to refuse a page to
    // somebody whose session is demonstrably still valid.
    await prisma.session
      .update({ where: { id: session.id }, data: { expiresAt: renewed } })
      .catch(() => {});
    session.expiresAt = renewed;
  }

  return session;
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token) {
    await prisma.session
      .deleteMany({ where: { token: fingerprint(token) } })
      .catch(() => {});
  }

  store.delete(SESSION_COOKIE);
}

/** Signs every device out — used after a password change. */
export async function destroyAllSessionsFor(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
}

export function constantTimeEqual(a: string, b: string) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

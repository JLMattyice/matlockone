import "server-only";

import { headers } from "next/headers";

import { prisma } from "./db";

/**
 * Abuse limits on the doors that face the open internet.
 *
 * Since 0.3.0 sign-up is the front of the product rather than a desktop
 * first-run screen, which means an unauthenticated form that creates a
 * workspace and an unauthenticated form that checks passwords are both
 * reachable by anyone. Neither had a limit.
 *
 * Fixed windows, counted in the database. Not a token bucket and not sliding:
 * a counter and an expiry are enough to turn an unlimited guessing rate into a
 * handful of attempts per window, and the simpler thing is the one that stays
 * correct on two database engines and across serverless instances that share
 * nothing.
 *
 * What this is not: protection against a distributed attacker. A thousand
 * addresses each trying ten passwords still gets ten thousand attempts. What
 * it stops is the single source working through a word list, which is the
 * attack a small business's login actually sees.
 */

export type RateLimitRule = {
  /** Attempts allowed inside one window. */
  limit: number;
  windowSeconds: number;
};

export type RateLimitVerdict = {
  ok: boolean;
  /** Attempts left in this window. Zero once refused. */
  remaining: number;
  /** Whole seconds until the window closes. Zero when allowed. */
  retryAfterSeconds: number;
};

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * Sign-in, per email address.
 *
 * Ten is generous for somebody who has forgotten which password they used and
 * nowhere near enough to work through a list. Keyed on the address rather than
 * where the request came from because that is what an attacker cannot vary,
 * and because a whole office behind one address must not lock each other out.
 */
export const LOGIN_PER_EMAIL: RateLimitRule = { limit: 10, windowSeconds: 15 * MINUTE };

/**
 * Sign-in, per source address, across every account.
 *
 * Catches the other shape: one password tried against many addresses. Set high
 * enough that a busy office sharing one address never meets it.
 */
export const LOGIN_PER_IP: RateLimitRule = { limit: 50, windowSeconds: 15 * MINUTE };

/**
 * New workspaces from one address.
 *
 * A real person signs up once. This is about the script that signs up a
 * thousand times, each one seeding an organization and a user row.
 */
export const SIGNUP_PER_IP: RateLimitRule = { limit: 5, windowSeconds: HOUR };

/**
 * Minting a payment session for one invoice.
 *
 * The Clover redirect calls out to a processor on every hit, so an invoice
 * token in the wrong hands is a way to make Matlock One hammer somebody's
 * merchant account. A client reloading their own invoice a few times is fine.
 */
export const PAY_REDIRECT_PER_INVOICE: RateLimitRule = { limit: 20, windowSeconds: HOUR };

/**
 * Checking the current password before a password change, per account.
 *
 * The one place a signed-in session can test a password. Somebody holding a
 * stolen session could otherwise try the real password as fast as the form
 * posts, and a right guess lets them set a new one and lock the owner out of
 * their own account. Five in fifteen minutes is more mistyping than anybody
 * does.
 */
export const PASSWORD_CHECK_PER_USER: RateLimitRule = { limit: 5, windowSeconds: 15 * MINUTE };

/**
 * Share links that do not exist, per source address.
 *
 * A share link is the only credential its page has, and nothing slowed
 * somebody working through guesses at one. A client opens a real link, so only
 * misses are counted: a genuine link can be opened as often as anybody likes.
 * An address past the limit is refused every link, genuine ones included, so a
 * guesser cannot tell a hit from a miss by whether they were let in.
 *
 * Thirty is far more mistyped links than a person produces in an hour, and far
 * fewer guesses than a search needs.
 */
export const SHARE_MISSES_PER_IP: RateLimitRule = { limit: 30, windowSeconds: HOUR };

/**
 * Counts one attempt against a key.
 *
 * Returns whether it is allowed *after* counting: the attempt that trips the
 * limit is refused, not the one after it.
 *
 * The read and the write are not atomic, so two requests landing together can
 * both see the same count and one increment can be lost. That is deliberate.
 * Locking the row would serialize every sign-in in the application to protect
 * against an attacker gaining, at most, one extra attempt per window.
 */
export async function hit(
  key: string,
  rule: RateLimitRule,
): Promise<RateLimitVerdict> {
  const now = new Date();

  const existing = await prisma.rateLimit.findUnique({ where: { key } });

  // No window, or the last one has closed: this attempt opens a new one.
  if (!existing || existing.windowEnd <= now) {
    const windowEnd = new Date(now.getTime() + rule.windowSeconds * 1000);

    await prisma.rateLimit.upsert({
      where: { key },
      create: { key, count: 1, windowEnd },
      update: { count: 1, windowEnd },
    });

    void sweep(now);

    return {
      ok: true,
      remaining: Math.max(0, rule.limit - 1),
      retryAfterSeconds: 0,
    };
  }

  const count = existing.count + 1;
  await prisma.rateLimit.update({ where: { key }, data: { count } });

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((existing.windowEnd.getTime() - now.getTime()) / 1000),
  );

  if (count > rule.limit) {
    return { ok: false, remaining: 0, retryAfterSeconds };
  }

  return { ok: true, remaining: rule.limit - count, retryAfterSeconds: 0 };
}

/**
 * Whether a key has used up its window, without counting this as an attempt.
 *
 * For the limits that count only failures. A share link counts a miss, but an
 * address that has already missed too often must be turned away before the
 * link is even looked up — otherwise its next guess is still a real check.
 */
export async function peek(key: string, rule: RateLimitRule): Promise<RateLimitVerdict> {
  const existing = await prisma.rateLimit.findUnique({ where: { key } });
  const now = Date.now();

  if (!existing || existing.windowEnd.getTime() <= now) {
    return { ok: true, remaining: rule.limit, retryAfterSeconds: 0 };
  }

  if (existing.count < rule.limit) {
    return { ok: true, remaining: rule.limit - existing.count, retryAfterSeconds: 0 };
  }

  return {
    ok: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil((existing.windowEnd.getTime() - now) / 1000)),
  };
}

/**
 * Forgets a key, called when the thing being guarded succeeds.
 *
 * Someone who signs in correctly has proved they are not the attacker the
 * count was accumulating against, so their next bad evening of typing starts
 * from zero.
 */
export async function forget(key: string): Promise<void> {
  await prisma.rateLimit.deleteMany({ where: { key } });
}

/**
 * Drops windows that closed long ago.
 *
 * Rows are small but every distinct address and email that ever tried leaves
 * one. Swept opportunistically rather than on a schedule, because neither
 * deployment has a scheduler this could hang off — the hosted one is
 * serverless and the desktop one is somebody's PC.
 *
 * One in fifty resets, so it costs nothing in the common path, and failures
 * are swallowed: housekeeping must never be the reason a sign-in fails.
 */
async function sweep(now: Date): Promise<void> {
  if (Math.random() > 0.02) return;

  const cutoff = new Date(now.getTime() - 24 * HOUR * 1000);

  try {
    await prisma.rateLimit.deleteMany({ where: { windowEnd: { lt: cutoff } } });
  } catch {
    // Nothing to do about it, and nothing worth failing a request over.
  }
}

/**
 * Where a request came from, as far as it can be known.
 *
 * Only trustworthy behind a proxy that sets it — which the hosted deployment
 * is, since Vercel overwrites the header. Read directly by a desktop install
 * on an office network there is usually no header at all, and everyone there
 * shares the single "unknown" bucket. That is why the login limits lean on the
 * email address and why sign-up limiting is skipped entirely on a desktop
 * install, whose first screen is a sign-up form.
 *
 * The leftmost entry is the client; anything after it is a proxy hop.
 */
export async function clientAddress(): Promise<string> {
  let headerList: Headers;

  try {
    headerList = await headers();
  } catch {
    // `headers()` throws outside a request — a scheduled sweep, a script, a
    // desktop background task. Every caller today is inside one, but a limiter
    // must never be the reason something else fails, and "unknown" is already
    // a bucket this handles.
    return "unknown";
  }

  const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;

  const real = headerList.get("x-real-ip")?.trim();
  if (real) return real;

  return "unknown";
}

/** How long to wait, in words somebody can act on. */
export function retryAfterPhrase(seconds: number): string {
  if (seconds <= 90) return "in a minute";

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes} minutes`;

  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "in an hour" : `in ${hours} hours`;
}

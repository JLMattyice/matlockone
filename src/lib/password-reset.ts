import "server-only";

import { createHmac } from "node:crypto";

import { systemMailer, type SystemMailer } from "@/lib/checkout/deliver";
import { resolveAppUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { deliverEmail, type OutboundEmail } from "@/lib/email/providers";
import { constantTimeEqual } from "@/lib/session";

/**
 * "Forgot password?" — a link by email that lets somebody choose a new one.
 *
 * The link is signed, not stored. It names the account and the moment it runs
 * out, and its signature covers the account's current password hash as well.
 * So it needs no table and no migration, and it is single-use for free: the
 * moment a new password is saved, the hash changes and every link sent before
 * it stops matching. A link cannot be made without the server's secret, and it
 * dies after RESET_LINK_MINUTES whether it was used or not.
 *
 * Sent from Matlock's own mailbox (SYSTEM_MAIL_*), the same one licence keys
 * go out through. A business's own mail settings are no use here: the person
 * asking is exactly the one who cannot sign in to reach them.
 */

export const RESET_LINK_MINUTES = 60;

/** Where the link lands. The token follows as the last part of the path. */
export const RESET_PATH = "/reset-password";

/**
 * The signing key, derived from SESSION_SECRET for this one purpose, so a
 * reset signature can never be mistaken for anything else signed with it.
 */
function resetKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET must be set to at least 16 characters. See .env.example.");
  }
  return createHmac("sha256", secret).update("matlock-one:password-reset:v1").digest();
}

function signature(body: string, passwordHash: string) {
  return createHmac("sha256", resetKey()).update(`${body}|${passwordHash}`).digest("base64url");
}

/** A link's token for this account, good for RESET_LINK_MINUTES from `now`. */
export function resetToken(
  user: { id: string; passwordHash: string },
  now: Date = new Date(),
): string {
  const expires = Math.floor(now.getTime() / 1000) + RESET_LINK_MINUTES * 60;
  const body = `${user.id}.${expires.toString(36)}`;
  return `${body}.${signature(body, user.passwordHash)}`;
}

/**
 * The account a token opens, or null if it is malformed, forged, expired,
 * already used, or for someone who has since been deactivated.
 */
export async function userForResetToken(token: string, now: Date = new Date()) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [id, expiresRaw, given] = parts;
  const expires = Number.parseInt(expiresRaw, 36);
  if (!id || !Number.isFinite(expires) || expires * 1000 <= now.getTime()) return null;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || !user.isActive) return null;

  return constantTimeEqual(signature(`${id}.${expiresRaw}`, user.passwordHash), given)
    ? user
    : null;
}

/** The email itself. Pure, so its wording is testable. */
export function resetEmail(input: {
  to: string;
  name: string;
  businessName: string;
  link: string;
}): OutboundEmail {
  return {
    to: input.to,
    toName: input.name,
    subject: "Reset your Matlock One password",
    text: [
      `Hello ${input.name},`,
      "",
      `Someone asked to reset the password you use to sign in to ${input.businessName}`,
      `on Matlock One (${input.to}). If that was you, open this link to choose a new one:`,
      "",
      input.link,
      "",
      `The link works once, for the next ${RESET_LINK_MINUTES} minutes.`,
      "",
      "If you didn't ask, ignore this email. Your password has not changed, and",
      "nobody can use the link without this email.",
      "",
      "— Matlock One",
    ].join("\n"),
  };
}

export type RequestResetOptions = {
  mailer?: SystemMailer | null;
  send?: typeof deliverEmail;
  now?: Date;
};

export type RequestResetResult =
  | { ok: true; sent: number }
  | { ok: false; reason: "not-configured" };

/**
 * Emails a reset link to every active account on this email — usually one.
 *
 * The caller says the same thing whatever this finds, so the answer never
 * tells anybody whether an address has an account. A send that fails is
 * logged, not reported: the person sees "check your email" either way, and
 * the log is where somebody can find out why nothing came.
 */
export async function requestReset(
  emailRaw: string,
  options: RequestResetOptions = {},
): Promise<RequestResetResult> {
  const { send = deliverEmail, now = new Date() } = options;
  const mailer = options.mailer === undefined ? systemMailer() : options.mailer;
  if (!mailer) return { ok: false, reason: "not-configured" };

  const email = emailRaw.trim().toLowerCase();
  const users = await prisma.user.findMany({
    where: { email, isActive: true },
    include: { organization: { select: { name: true } } },
  });

  let sent = 0;
  for (const user of users) {
    const link = `${resolveAppUrl()}${RESET_PATH}/${resetToken(user, now)}`;
    try {
      const result = await send(
        mailer.provider,
        mailer.config,
        mailer.secret,
        resetEmail({ to: user.email, name: user.name, businessName: user.organization.name, link }),
      );
      if (result.ok) sent++;
      else console.error(`[password-reset] Could not email ${user.id}: ${result.error}`);
    } catch (error) {
      console.error(`[password-reset] Could not email ${user.id}`, error);
    }
  }

  return { ok: true, sent };
}

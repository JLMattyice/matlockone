import { formatPrice } from "./plans";
import { prisma } from "@/lib/db";
import type { EmailConfig, EmailProviderId } from "@/lib/email/catalog";
import {
  deliverEmail,
  type DeliveryResult,
  type OutboundEmail,
} from "@/lib/email/providers";
import type { Purchase } from "@/generated/prisma/client";

/**
 * Sending a buyer their licence key.
 *
 * This is Matlock's own mailbox, and it is deliberately not the same thing as
 * the email settings a customer configures. Those credentials belong to the
 * customer and are encrypted per organization; these belong to us and come from
 * the environment of the hosted deployment. A purchase has no organization to
 * borrow a mailbox from anyway — the buyer has not installed anything yet.
 *
 * Nothing here throws. A send that fails must leave a record saying so, because
 * the alternative is a paid customer with no key and nobody knowing.
 */

export type SystemMailer = {
  provider: EmailProviderId;
  config: EmailConfig;
  secret: string;
};

/**
 * Matlock's own sending account, or null when this deployment has none.
 *
 * Null is a normal state, not a failure: a desktop install and a developer's
 * laptop both legitimately cannot send licence emails.
 */
export function systemMailer(): SystemMailer | null {
  const fromEmail = process.env.SYSTEM_MAIL_FROM_EMAIL?.trim();
  if (!fromEmail) return null;

  const fromName = process.env.SYSTEM_MAIL_FROM_NAME?.trim() || "Matlock One";

  const resendKey = process.env.SYSTEM_MAIL_RESEND_API_KEY?.trim();
  if (resendKey) {
    return {
      provider: "RESEND",
      config: { fromName, fromEmail },
      secret: resendKey,
    };
  }

  const host = process.env.SYSTEM_MAIL_SMTP_HOST?.trim();
  const password = process.env.SYSTEM_MAIL_SMTP_PASSWORD;
  if (!host || !password) return null;

  const port = Number(process.env.SYSTEM_MAIL_SMTP_PORT ?? 587);

  return {
    provider: "SMTP",
    config: {
      fromName,
      fromEmail,
      host,
      port: Number.isFinite(port) ? port : 587,
      // 465 is implicit TLS; 587 upgrades with STARTTLS. Getting this wrong is
      // the most common reason a correct password still cannot connect.
      secure: process.env.SYSTEM_MAIL_SMTP_SECURE
        ? process.env.SYSTEM_MAIL_SMTP_SECURE === "true"
        : port === 465,
      username: process.env.SYSTEM_MAIL_SMTP_USER?.trim() || fromEmail,
    },
    secret: password,
  };
}

/**
 * The message itself. Pure, so its wording is testable.
 *
 * Plain text on purpose. The one thing this email exists to carry is a long
 * key that has to survive being copied, and every HTML mail client in the world
 * is willing to insert a line break or a smart quote into it.
 */
export function licenseEmail(purchase: Purchase): OutboundEmail {
  const seats =
    purchase.seats === null
      ? "unlimited people"
      : `${purchase.seats} ${purchase.seats === 1 ? "person" : "people"}`;

  const plan = purchase.plan[0].toUpperCase() + purchase.plan.slice(1);

  const lines = [
    purchase.orgName ? `Hello ${purchase.orgName},` : "Hello,",
    "",
    "Thank you for subscribing to Matlock One. Here is your licence key:",
    "",
    purchase.licenseKey ?? "",
    "",
    "To use it:",
    "",
    "  1. Open Matlock One",
    "  2. Go to Settings, then Licence",
    "  3. Paste the key and press Activate",
    "",
    `It covers ${seats} on the ${plan} plan.`,
    "",
    "Everything already in your workspace stays exactly where it is when you",
    "activate. Nothing is deleted and nobody is signed out.",
    "",
    "Keep this email. The same key can be pasted again if you move Matlock One",
    "to another machine, and we can always send it to you again.",
    "",
    `Reference: ${purchase.provider}/${purchase.externalId}`,
    `Amount: ${formatPrice(purchase.amountCents, purchase.currency)}`,
    "",
    "— Matlock Software Development",
  ];

  return {
    to: purchase.email,
    toName: purchase.orgName,
    subject: `Your Matlock One licence key (${plan})`,
    text: lines.join("\n"),
  };
}

export type DeliverOutcome =
  | { ok: true; skipped: boolean }
  | { ok: false; error: string };

export type DeliverOptions = {
  mailer?: SystemMailer | null;
  send?: typeof deliverEmail;
  now?: Date;
};

/**
 * Sends the key and writes down what happened.
 *
 * Already delivered is a success, not a resend. Webhook retries are routine,
 * and a customer receiving the same key four times reads as a system out of
 * control — worse, it trains them to ignore the email that matters.
 */
export async function deliverLicense(
  purchase: Purchase,
  options: DeliverOptions = {},
): Promise<DeliverOutcome> {
  const { send = deliverEmail, now = new Date() } = options;
  const mailer = options.mailer === undefined ? systemMailer() : options.mailer;

  if (purchase.deliveredAt) return { ok: true, skipped: true };

  if (!purchase.licenseKey) {
    return { ok: false, error: "That purchase has no licence to send." };
  }

  if (!mailer) {
    const error =
      "No sending account configured. Set SYSTEM_MAIL_FROM_EMAIL and either " +
      "SYSTEM_MAIL_RESEND_API_KEY or the SYSTEM_MAIL_SMTP_* settings.";

    await record(purchase.id, { deliveryError: error });
    return { ok: false, error };
  }

  let result: DeliveryResult;
  try {
    result = await send(
      mailer.provider,
      mailer.config,
      mailer.secret,
      licenseEmail(purchase),
    );
  } catch (error) {
    // deliverEmail returns rather than throws, but a mailer injected by a
    // caller might not, and losing a paid customer's key to an exception is
    // not an acceptable outcome.
    result = {
      ok: false,
      error: error instanceof Error ? error.message : "Sending failed.",
    };
  }

  if (!result.ok) {
    await record(purchase.id, { deliveryError: result.error });
    return { ok: false, error: result.error };
  }

  await record(purchase.id, { deliveredAt: now, deliveryError: null });
  return { ok: true, skipped: false };
}

async function record(
  id: string,
  data: { deliveredAt?: Date; deliveryError?: string | null },
) {
  try {
    await prisma.purchase.update({ where: { id }, data });
  } catch {
    // The email is what matters; failing to note it must not turn a delivered
    // key into a reported failure that someone then sends a second time.
  }
}

/** Purchases that are paid and issued but never reached anyone. */
export function undeliveredPurchases() {
  return prisma.purchase.findMany({
    where: { deliveredAt: null, licenseKey: { not: null } },
    orderBy: { createdAt: "asc" },
  });
}

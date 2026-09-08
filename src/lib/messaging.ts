import "server-only";

import type { MessageChannel } from "./constants";
import { prisma } from "./db";
import {
  deliverEmail,
  type EmailAttachment,
  isEmailProvider,
  type EmailConfig,
} from "./email/providers";
import { open as openSecret } from "./secret-box";

/**
 * Outbound email and SMS.
 *
 * Every message is written to the `OutboxMessage` table first, then handed to
 * whichever account the organization has connected under Settings → Email. If
 * nothing is connected the row is still written and marked queued, so a demo
 * shows the full trail without sending anything and without pretending it did.
 *
 * Callers never choose a provider. They say what to send and to whom; which
 * mailbox it leaves by is a setting, not a call site.
 */

export type OutboundMessage = {
  organizationId: string;
  channel: MessageChannel;
  to: string;
  toName?: string | null;
  subject?: string | null;
  body: string;
  relatedType?: string;
  relatedId?: string;
  createdById?: string | null;
  /** Files to send with it. Not stored in the outbox — only the text is. */
  attachments?: EmailAttachment[];
};

export type SendResult = {
  ok: boolean;
  messageId: string;
  /** False when nothing is connected — queued, not failed. */
  delivered: boolean;
  error?: string;
};

type ResolvedEmailAccount = {
  provider: "SMTP" | "RESEND";
  config: EmailConfig;
  secret: string;
};

/**
 * Loads and decrypts the connected email account.
 *
 * Returns null for every "not usable" case — nothing connected, switched off,
 * or a secret that will not decrypt because the encryption key changed — so
 * callers handle one shape instead of four.
 */
export async function resolveEmailAccount(
  organizationId: string,
): Promise<ResolvedEmailAccount | null> {
  const integration = await prisma.integration.findUnique({
    where: { organizationId_kind: { organizationId, kind: "EMAIL" } },
  });

  if (!integration || !integration.isActive) return null;
  if (!isEmailProvider(integration.provider)) return null;

  const secret = openSecret({
    cipherText: integration.secretCipher ?? undefined,
    nonce: integration.secretNonce ?? undefined,
    tag: integration.secretTag ?? undefined,
  });
  if (!secret) return null;

  let config: EmailConfig;
  try {
    config = JSON.parse(integration.config ?? "{}") as EmailConfig;
  } catch {
    return null;
  }

  if (!config.fromEmail) return null;

  return { provider: integration.provider, config, secret };
}

export async function sendMessage(message: OutboundMessage): Promise<SendResult> {
  const account =
    message.channel === "EMAIL"
      ? await resolveEmailAccount(message.organizationId)
      : null;

  const row = await prisma.outboxMessage.create({
    data: {
      organizationId: message.organizationId,
      channel: message.channel,
      toAddress: message.to,
      toName: message.toName ?? null,
      subject: message.subject ?? null,
      body: message.body,
      status: "QUEUED",
      provider: account ? account.provider.toLowerCase() : "none",
      relatedType: message.relatedType ?? null,
      relatedId: message.relatedId ?? null,
      createdById: message.createdById ?? null,
    },
  });

  // Nothing connected. The message is recorded and visible, but claiming it
  // was sent would be a lie the customer only discovers when nobody replies.
  if (!account) {
    return {
      ok: true,
      delivered: false,
      messageId: row.id,
      error:
        message.channel === "EMAIL"
          ? "No email account is connected, so this was saved but not sent. Connect one under Settings → Email."
          : "Text messaging is not connected yet.",
    };
  }

  const result = await deliverEmail(account.provider, account.config, account.secret, {
    to: message.to,
    toName: message.toName,
    subject: message.subject ?? "(no subject)",
    text: message.body,
    attachments: message.attachments,
    // Replies go to the business, not to the mailbox that happened to send it.
    replyTo: account.config.fromEmail,
  });

  await prisma.outboxMessage.update({
    where: { id: row.id },
    data: result.ok
      ? {
          status: "SENT",
          sentAt: new Date(),
          providerMessageId: result.providerMessageId ?? null,
        }
      : { status: "FAILED", failedAt: new Date(), error: result.error },
  });

  return result.ok
    ? { ok: true, delivered: true, messageId: row.id }
    : { ok: false, delivered: false, messageId: row.id, error: result.error };
}

/** Absolute URL for a client-facing document link. */
export function publicUrl(path: string) {
  const base = process.env.APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  bool,
  failed,
  invalid,
  saved,
  text,
  type ActionState,
} from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  deliverEmail,
  EMAIL_PROVIDERS,
  type EmailConfig,
} from "@/lib/email/providers";
import { resolveEmailAccount } from "@/lib/messaging";
import { encryptionAvailable, seal } from "@/lib/secret-box";

/**
 * Connecting the mailbox that estimates and invoices go out from.
 *
 * The credential belongs to the customer — their own mail account or their own
 * API key. It is encrypted before it touches the database and is never read
 * back into a form field; changing it means typing a new one.
 */

const schema = z
  .object({
    provider: z.enum(EMAIL_PROVIDERS),
    fromName: z.string().trim().min(1, "Enter the name clients should see."),
    fromEmail: z.string().trim().email("Enter a valid email address."),
    host: z.string().trim().nullish(),
    port: z.coerce.number().int().min(1).max(65535).nullish(),
    secure: z.boolean(),
    username: z.string().trim().nullish(),
    secret: z.string().nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.provider !== "SMTP") return;

    if (!value.host) {
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "Enter the outgoing mail server, e.g. smtp.gmail.com.",
      });
    }
    if (!value.username) {
      ctx.addIssue({
        code: "custom",
        path: ["username"],
        message: "Enter the username you sign in with — usually the full address.",
      });
    }
  });

export async function saveEmailAccount(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org, user } = await requirePermission("settings:write");

  if (!encryptionAvailable()) {
    return failed(
      "This installation cannot store credentials securely yet. Set ENCRYPTION_KEY and restart before connecting an account.",
    );
  }

  const parsed = schema.safeParse({
    provider: formData.get("provider"),
    fromName: formData.get("fromName"),
    fromEmail: formData.get("fromEmail"),
    host: text(formData, "host"),
    port: text(formData, "port") ?? 587,
    secure: bool(formData, "secure"),
    username: text(formData, "username"),
    secret: text(formData, "secret"),
  });

  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const existing = await prisma.integration.findUnique({
    where: { organizationId_kind: { organizationId: org.id, kind: "EMAIL" } },
  });

  // Switching providers invalidates the stored secret: a mail password is not
  // an API key. Anything else may keep what is already saved.
  const keepExisting =
    !input.secret &&
    existing?.secretCipher != null &&
    existing.provider === input.provider;

  if (!input.secret && !keepExisting) {
    return {
      ok: false,
      fieldErrors: {
        secret:
          input.provider === "SMTP"
            ? "Enter the password for this mailbox."
            : "Enter the API key.",
      },
    };
  }

  const config: EmailConfig = {
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    ...(input.provider === "SMTP"
      ? {
          host: input.host ?? undefined,
          port: input.port ?? 587,
          secure: input.secure,
          username: input.username ?? undefined,
        }
      : {}),
  };

  const sealed = input.secret ? seal(input.secret) : null;

  const data = {
    provider: input.provider,
    isActive: true,
    config: JSON.stringify(config),
    ...(sealed
      ? {
          secretCipher: sealed.cipherText,
          secretNonce: sealed.nonce,
          secretTag: sealed.tag,
          secretHint: input.secret!.slice(-4),
          // A new credential has not been proven to work yet.
          lastTestedAt: null,
          lastTestOk: null,
          lastError: null,
        }
      : {}),
  };

  await prisma.integration.upsert({
    where: { organizationId_kind: { organizationId: org.id, kind: "EMAIL" } },
    create: {
      organizationId: org.id,
      kind: "EMAIL",
      createdById: user.id,
      ...data,
    },
    update: data,
  });

  revalidatePath("/settings/email");
  return saved("Email account saved. Send a test to confirm it works.");
}

export async function sendTestEmail(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org, user } = await requirePermission("settings:write");

  const to = text(formData, "to") ?? user.email;
  if (!z.string().email().safeParse(to).success) {
    return { ok: false, fieldErrors: { to: "Enter a valid email address." } };
  }

  const account = await resolveEmailAccount(org.id);
  if (!account) {
    return failed(
      "No usable email account is connected. Save your details first, and re-enter the password if this installation's data was moved from another machine.",
    );
  }

  const result = await deliverEmail(account.provider, account.config, account.secret, {
    to,
    subject: `Test email from ${org.name}`,
    text: [
      `This is a test from Matlock One.`,
      "",
      `If you are reading this, ${org.name} can send estimates and invoices from ${account.config.fromEmail}.`,
    ].join("\n"),
    replyTo: account.config.fromEmail,
  });

  await prisma.integration.update({
    where: { organizationId_kind: { organizationId: org.id, kind: "EMAIL" } },
    data: {
      lastTestedAt: new Date(),
      lastTestOk: result.ok,
      lastError: result.ok ? null : result.error,
    },
  });

  revalidatePath("/settings/email");

  return result.ok
    ? saved(`Test sent to ${to}. Check that it arrived — including the spam folder.`)
    : failed(result.error);
}

export async function disconnectEmailAccount() {
  const { org } = await requirePermission("settings:write");

  // Deleted, not deactivated: leaving an encrypted password behind for a
  // mailbox the business has stopped using is a liability, not a convenience.
  await prisma.integration.deleteMany({
    where: { organizationId: org.id, kind: "EMAIL" },
  });

  revalidatePath("/settings/email");
}

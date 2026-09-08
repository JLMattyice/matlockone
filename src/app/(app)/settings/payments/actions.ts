"use server";

import { revalidatePath } from "next/cache";

import {
  failed,
  saved,
  text,
  type ActionState,
} from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { resolveProcessor } from "@/lib/payments/account";
import {
  isPaymentProvider,
  PAYMENT_PROVIDER_META,
  partitionFields,
} from "@/lib/payments/catalog";
import { adapterFor, allAdapters } from "@/lib/payments/providers";
import { encryptionAvailable, seal } from "@/lib/secret-box";

/**
 * Connecting the processor that clients pay through.
 *
 * The account belongs to the business, exactly as with email. Secret fields
 * are sealed into one encrypted blob; everything else is plain config, so the
 * settings screen can show the host of a payment link or which Square location
 * the money lands in without decrypting anything.
 */

export async function savePaymentProcessor(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org, user } = await requirePermission("settings:write");

  const provider = formData.get("provider");
  if (!isPaymentProvider(provider)) {
    return failed("Choose a payment provider.");
  }

  const meta = PAYMENT_PROVIDER_META[provider];
  if (!meta.available || !adapterFor(provider)) {
    return failed(`${meta.label} is not available in this version yet.`);
  }

  const { secrets, plain } = partitionFields(meta);

  if (secrets.length > 0 && !encryptionAvailable()) {
    return failed(
      "This installation cannot store credentials securely yet. Set ENCRYPTION_KEY and restart before connecting an account.",
    );
  }

  const existing = await prisma.integration.findUnique({
    where: { organizationId_kind: { organizationId: org.id, kind: "PAYMENT" } },
  });
  // Switching providers invalidates whatever was stored: a Stripe key is not a
  // Square token, and must not be carried across.
  const sameProvider = existing?.provider === provider;

  const fieldErrors: Record<string, string> = {};

  const config: Record<string, string> = {};
  for (const field of plain) {
    const value = text(formData, field.name);
    if (!value && !field.optional) {
      fieldErrors[field.name] = `${field.label} is required.`;
    }
    if (value) config[field.name] = value;
  }

  // A blank secret means "keep what is already saved" — but only for the same
  // provider, and only if there is something to keep.
  const submitted: Record<string, string> = {};
  for (const field of secrets) {
    const value = text(formData, field.name);
    if (value) submitted[field.name] = value;
  }

  const keepExisting =
    Object.keys(submitted).length === 0 &&
    sameProvider &&
    existing?.secretCipher != null;

  if (secrets.length > 0 && !keepExisting) {
    for (const field of secrets) {
      if (!submitted[field.name] && !field.optional) {
        fieldErrors[field.name] = `${field.label} is required.`;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  const sealed =
    secrets.length > 0 && !keepExisting ? seal(JSON.stringify(submitted)) : null;

  // The last secret field is the one worth hinting at — a Stripe key, a Square
  // token, a PayPal secret — rather than the client ID that precedes it.
  const hintSource = secrets.at(-1)?.name;
  const secretHint = hintSource ? (submitted[hintSource]?.slice(-4) ?? null) : null;

  const secretColumns = sealed
    ? {
        secretCipher: sealed.cipherText,
        secretNonce: sealed.nonce,
        secretTag: sealed.tag,
        secretHint,
      }
    : keepExisting
      ? {}
      : // No secrets for this provider: clear anything the last one left.
        {
          secretCipher: null,
          secretNonce: null,
          secretTag: null,
          secretHint: null,
        };

  const data = {
    provider,
    isActive: true,
    config: JSON.stringify(config),
    // Whatever changed, an earlier pass is no longer evidence this works.
    lastTestedAt: null,
    lastTestOk: null,
    lastError: null,
    ...secretColumns,
  };

  await prisma.integration.upsert({
    where: { organizationId_kind: { organizationId: org.id, kind: "PAYMENT" } },
    create: {
      organizationId: org.id,
      kind: "PAYMENT",
      createdById: user.id,
      ...data,
    },
    update: data,
  });

  // Whatever the processor was holding was minted from the old details. PayPal
  // caches an access token for nine hours, so without this a corrected secret
  // would appear to change nothing at all.
  adapterFor(provider)?.forget?.();

  revalidatePath("/settings/payments");
  revalidatePath("/invoices");
  return saved(`${meta.label} saved. Test it to confirm it works.`);
}

export async function testPaymentProcessor(
  _prev: ActionState,
): Promise<ActionState> {
  const { org } = await requirePermission("settings:write");

  const processor = await resolveProcessor(org.id);
  if (!processor) {
    return failed(
      "No usable processor is connected. Save your details first, and re-enter any secret if this installation's data was moved from another machine.",
    );
  }

  const result = await processor.adapter.verify(
    processor.config,
    processor.credentials,
  );

  await prisma.integration.update({
    where: { organizationId_kind: { organizationId: org.id, kind: "PAYMENT" } },
    data: {
      lastTestedAt: new Date(),
      lastTestOk: result.ok,
      lastError: result.ok ? null : result.error,
    },
  });

  revalidatePath("/settings/payments");

  return result.ok
    ? saved(`Working — payments go to ${result.value.accountLabel}.`)
    : failed(result.error);
}

export async function disconnectPaymentProcessor() {
  const { org } = await requirePermission("settings:write");

  await prisma.integration.deleteMany({
    where: { organizationId: org.id, kind: "PAYMENT" },
  });

  // Disconnecting should not leave a live access token sitting in memory.
  for (const adapter of allAdapters()) adapter.forget?.();

  // Links already on invoices keep working — they point at the processor, not
  // at Matlock One — but nothing new is created and no further polling happens.
  revalidatePath("/settings/payments");
  revalidatePath("/invoices");
}

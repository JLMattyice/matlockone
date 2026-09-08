import { randomUUID } from "node:crypto";

import { PLANS, isPlan, priceCents } from "./plans";
import { prisma } from "@/lib/db";
import { issueLicense, type LicensePlan } from "@/lib/license/token";
import type { Purchase } from "@/generated/prisma/client";

/*
 * The signing key is passed in rather than imported.
 *
 * `src/lib/license/private-key.ts` carries `server-only`, which is exactly
 * right for the module that reads the secret — and which would make this
 * module unimportable from a test runner or a CLI. Keeping the guard on the
 * secret and taking the key as an argument means the fulfilment rules can be
 * exercised against a throwaway key, which is the only way the idempotency
 * guarantee below gets tested at all.
 */

/**
 * Turning a completed payment into a licence.
 *
 * The whole point of this module is that it can be called twice.
 *
 * Every processor retries. PayPal resends a webhook it did not get a 200 for,
 * a customer double-clicks, a support person re-runs a fulfilment by hand
 * after a timeout that had actually succeeded. If any of those minted a second
 * licence, the customer would hold two keys with different expiry dates and
 * the one they pasted would be a coin flip. So the sale is recorded first,
 * under the processor's own id behind a unique index, and the licence is
 * signed once and kept.
 */

export type FulfilInput = {
  provider: string;
  /** The processor's id for this sale. The idempotency key. */
  externalId: string;
  email: string;
  orgName?: string | null;
  plan: LicensePlan;
  months?: number;
  /** Overrides the plan's seats. For a negotiated deal. */
  seats?: number | null;
  amountCents?: number;
  currency?: string;
};

export type FulfilResult =
  | { ok: true; purchase: Purchase; licenseKey: string; reissued: boolean }
  | { ok: false; error: string };

export type FulfilOptions = {
  /** PEM for the Ed25519 signing key. From licensePrivateKey() in the app. */
  privateKey: string;
  now?: Date;
};

export async function fulfilPurchase(
  input: FulfilInput,
  { privateKey, now = new Date() }: FulfilOptions,
): Promise<FulfilResult> {
  if (!isPlan(input.plan)) {
    return { ok: false, error: `Unknown plan "${input.plan}".` };
  }

  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    return { ok: false, error: "A valid email is required to issue a licence." };
  }

  const externalId = input.externalId.trim();
  if (!externalId) {
    return { ok: false, error: "The processor's reference is required." };
  }

  const plan = PLANS[input.plan];
  const months = input.months ?? 12;
  if (!Number.isInteger(months) || months <= 0) {
    return { ok: false, error: "Term must be a whole number of months." };
  }

  const seats = input.seats === undefined ? plan.seats : input.seats;

  // Already fulfilled? Hand back exactly what was issued the first time. A
  // customer chasing a lost email must get the key they already have, not a
  // second one that quietly invalidates their first.
  const existing = await prisma.purchase.findUnique({
    where: {
      provider_externalId: { provider: input.provider, externalId },
    },
  });

  if (existing?.licenseKey) {
    return {
      ok: true,
      purchase: existing,
      licenseKey: existing.licenseKey,
      reissued: true,
    };
  }

  let signed: string;
  const licenseId = `lic_${randomUUID()}`;

  const expires = new Date(now);
  expires.setMonth(expires.getMonth() + months);

  try {
    signed = issueLicense(
      {
        id: licenseId,
        sub: email,
        org: input.orgName?.trim() || undefined,
        plan: plan.id,
        mode: "paid",
        seats,
        iat: Math.floor(now.getTime() / 1000),
        exp: Math.floor(expires.getTime() / 1000),
      },
      privateKey,
    );
  } catch (error) {
    // A deployment with no usable signing key must not record a sale it cannot
    // fulfil: that would leave a paid purchase permanently un-issuable behind
    // its own idempotency key.
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not sign a licence.",
    };
  }

  const data = {
    provider: input.provider,
    externalId,
    email,
    orgName: input.orgName?.trim() || null,
    plan: plan.id,
    seats,
    months,
    amountCents: input.amountCents ?? priceCents(plan, months),
    currency: input.currency ?? "USD",
    status: "PAID",
    licenseId,
    licenseKey: signed,
    issuedAt: now,
  };

  // upsert, not create: two webhooks arriving at once both miss the findUnique
  // above, and the loser of that race must update the row rather than crash on
  // the unique index.
  const purchase = await prisma.purchase.upsert({
    where: {
      provider_externalId: { provider: input.provider, externalId },
    },
    create: data,
    update: {},
  });

  // The race's loser: the row already carried a licence, so keep that one.
  if (purchase.licenseKey && purchase.licenseId !== licenseId) {
    return {
      ok: true,
      purchase,
      licenseKey: purchase.licenseKey,
      reissued: true,
    };
  }

  return { ok: true, purchase, licenseKey: signed, reissued: false };
}

/** Every licence issued to an address, newest first. For support. */
export async function purchasesFor(email: string) {
  return prisma.purchase.findMany({
    where: { email: email.trim().toLowerCase() },
    orderBy: { createdAt: "desc" },
  });
}

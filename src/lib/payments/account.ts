import "server-only";

import { isPaymentProvider, type PaymentProviderId } from "./catalog";
import {
  adapterFor,
  type PaymentAdapter,
  type PaymentConfig,
  type PaymentCredentials,
  type RemotePayment,
} from "./providers";
import { prisma } from "../db";
import { recalculateInvoice } from "../invoice-balance";
import { open as openSecret } from "../secret-box";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Loading the processor an organization has connected, and taking money in
 * from it safely.
 */

export type ConnectedProcessor = {
  provider: PaymentProviderId;
  adapter: PaymentAdapter;
  config: PaymentConfig;
  credentials: PaymentCredentials;
};

/**
 * Returns null for every "not usable" case — nothing connected, switched off,
 * an adapter this build does not have, or a secret that will not decrypt
 * because the encryption key changed. One shape for callers to handle instead
 * of four.
 */
export async function resolveProcessor(
  organizationId: string,
): Promise<ConnectedProcessor | null> {
  const integration = await prisma.integration.findUnique({
    where: { organizationId_kind: { organizationId, kind: "PAYMENT" } },
  });

  if (!integration || !integration.isActive) return null;
  if (!isPaymentProvider(integration.provider)) return null;

  const adapter = adapterFor(integration.provider);
  if (!adapter) return null;

  let config: PaymentConfig;
  try {
    config = JSON.parse(integration.config ?? "{}") as PaymentConfig;
  } catch {
    return null;
  }

  // Providers with no secret fields (a pasted payment link) store nothing to
  // decrypt, and must still resolve.
  let credentials: PaymentCredentials = {};
  if (integration.secretCipher) {
    const opened = openSecret({
      cipherText: integration.secretCipher,
      nonce: integration.secretNonce ?? undefined,
      tag: integration.secretTag ?? undefined,
    });
    if (!opened) return null;

    try {
      credentials = JSON.parse(opened) as PaymentCredentials;
    } catch {
      return null;
    }
  }

  return { provider: integration.provider, adapter, config, credentials };
}

export type ReconcileResult = {
  recorded: number;
  amountCents: number;
  settled: boolean;
  balanceCents: number;
};

/**
 * Writes payments a processor reports into the ledger.
 *
 * Polling repeats by nature, so this must be safe to run over and over. Each
 * row carries the processor's own id for the transaction, and the database
 * holds a unique index on (organization, provider, externalId) — a second
 * sighting of the same capture is rejected by the engine, not by a check that
 * could race with itself. The rejection is swallowed per payment so one
 * already-recorded item cannot abandon the rest of the batch.
 *
 * Amounts are trusted from the processor rather than assumed to equal the
 * balance: a client may pay part of an invoice, or pay twice.
 */
export async function recordRemotePayments(input: {
  organizationId: string;
  invoiceId: string;
  clientId: string;
  provider: PaymentProviderId;
  payments: RemotePayment[];
}): Promise<ReconcileResult> {
  let recorded = 0;
  let amountCents = 0;

  const summary = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      for (const payment of input.payments) {
        if (payment.amountCents <= 0) continue;

        try {
          await tx.payment.create({
            data: {
              organizationId: input.organizationId,
              invoiceId: input.invoiceId,
              clientId: input.clientId,
              amountCents: payment.amountCents,
              method: "ONLINE",
              receivedAt: payment.paidAt,
              reference: payment.reference ?? null,
              provider: input.provider,
              externalId: payment.externalId,
              // No user recorded it — the processor did.
              recordedById: null,
            },
          });

          recorded += 1;
          amountCents += payment.amountCents;
        } catch (error) {
          // P2002 is the unique violation: already recorded on an earlier
          // poll, which is the expected steady state, not a problem.
          if (!isUniqueViolation(error)) throw error;
        }
      }

      return recalculateInvoice(tx, input.invoiceId);
    },
  );

  return {
    recorded,
    amountCents,
    settled: summary?.settled ?? false,
    balanceCents: summary?.balanceCents ?? 0,
  };
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

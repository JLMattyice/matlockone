import type { Metadata } from "next";

import { PaymentsForm, type PaymentSettingsValues } from "./payments-form";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isPaymentProvider } from "@/lib/payments/catalog";
import { can } from "@/lib/permissions";
import { encryptionAvailable } from "@/lib/secret-box";

export const metadata: Metadata = { title: "Payments" };

export default async function PaymentSettingsPage() {
  const { user, org } = await requirePermission("settings:read");

  const integration = await prisma.integration.findUnique({
    where: { organizationId_kind: { organizationId: org.id, kind: "PAYMENT" } },
  });

  let config: Record<string, string> = {};
  try {
    const parsed = JSON.parse(integration?.config ?? "{}") as unknown;
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") config[key] = value;
      }
    }
  } catch {
    // A malformed row shows as unconfigured rather than crashing the screen.
    config = {};
  }

  const values: PaymentSettingsValues = {
    connected: Boolean(integration),
    provider: isPaymentProvider(integration?.provider)
      ? integration.provider
      : "MANUAL",
    config,
    hasStoredSecret: Boolean(integration?.secretCipher),
    secretHint: integration?.secretHint ?? null,
    lastTestedAt: integration?.lastTestedAt?.toISOString() ?? null,
    lastTestOk: integration?.lastTestOk ?? null,
    lastError: integration?.lastError ?? null,
    canEncrypt: encryptionAvailable(),
    readOnly: !can(user, "settings:write"),
  };

  return <PaymentsForm values={values} />;
}

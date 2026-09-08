import type { Metadata } from "next";

import { EmailForm, type EmailAccountValues } from "./email-form";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isEmailProvider } from "@/lib/email/catalog";
import { can } from "@/lib/permissions";
import { encryptionAvailable } from "@/lib/secret-box";

export const metadata: Metadata = { title: "Email" };

export default async function EmailSettingsPage() {
  const { user, org } = await requirePermission("settings:read");

  const integration = await prisma.integration.findUnique({
    where: { organizationId_kind: { organizationId: org.id, kind: "EMAIL" } },
  });

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(integration?.config ?? "{}") as Record<string, unknown>;
  } catch {
    // A malformed row shows as unconfigured rather than crashing the screen.
  }

  const str = (key: string) =>
    typeof config[key] === "string" ? (config[key] as string) : "";

  const values: EmailAccountValues = {
    connected: Boolean(integration?.secretCipher),
    provider: isEmailProvider(integration?.provider) ? integration.provider : "SMTP",
    fromName: str("fromName") || org.name,
    fromEmail: str("fromEmail") || org.email || "",
    host: str("host"),
    port: typeof config.port === "number" ? config.port : 587,
    secure: config.secure === true,
    username: str("username"),
    secretHint: integration?.secretHint ?? null,
    lastTestedAt: integration?.lastTestedAt?.toISOString() ?? null,
    lastTestOk: integration?.lastTestOk ?? null,
    lastError: integration?.lastError ?? null,
    testRecipient: user.email,
    canEncrypt: encryptionAvailable(),
    readOnly: !can(user, "settings:write"),
  };

  return <EmailForm values={values} />;
}

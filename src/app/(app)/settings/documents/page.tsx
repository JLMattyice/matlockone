import type { Metadata } from "next";

import { DocumentsForm } from "./documents-form";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Document defaults" };

export default async function DocumentSettingsPage() {
  const { user, org } = await requirePermission("settings:read");

  return (
    <DocumentsForm
      values={{
        taxRate: (org.defaultTaxRateBp / 100).toString(),
        invoicePrefix: org.invoicePrefix,
        invoiceNextNumber: org.invoiceNextNumber,
        estimatePrefix: org.estimatePrefix,
        estimateNextNumber: org.estimateNextNumber,
        jobPrefix: org.jobPrefix,
        jobNextNumber: org.jobNextNumber,
        defaultPaymentTermsDays: org.defaultPaymentTermsDays,
        defaultEstimateValidDays: org.defaultEstimateValidDays,
        invoiceFooter: org.invoiceFooter,
        estimateFooter: org.estimateFooter,
        readOnly: !can(user, "settings:write"),
      }}
    />
  );
}

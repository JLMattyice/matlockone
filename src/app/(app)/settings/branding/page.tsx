import type { Metadata } from "next";

import { BrandingForm } from "./branding-form";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Branding" };

export default async function BrandingPage() {
  const { user, org } = await requirePermission("settings:read");

  return (
    <BrandingForm
      values={{
        orgName: org.name,
        primaryColor: org.primaryColor,
        accentColor: org.accentColor,
        logoUrl: org.logoUrl,
        labelJobSingular: org.labelJobSingular,
        labelJobPlural: org.labelJobPlural,
        labelClientSingular: org.labelClientSingular,
        labelClientPlural: org.labelClientPlural,
        readOnly: !can(user, "settings:write"),
      }}
    />
  );
}

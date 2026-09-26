import { SettingsNav, type SettingsTab } from "./settings-nav";
import { dataStaysOnThisMachine } from "@/lib/config";
import { PageHeader } from "@/components/ui/page-header";
import { requireContext } from "@/lib/auth";
import { can } from "@/lib/permissions";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await requireContext();

  const tabs: SettingsTab[] = [{ href: "/settings/profile", label: "Your profile" }];

  if (can(user, "settings:read")) {
    tabs.unshift(
      { href: "/settings", label: "Business" },
      { href: "/settings/branding", label: "Branding" },
      { href: "/settings/documents", label: "Documents" },
      { href: "/settings/email", label: "Email" },
      { href: "/settings/payments", label: "Payments" },
      { href: "/settings/automations", label: "Automations" },
      // The hosted app is paid by subscription, a desktop install by key.
      dataStaysOnThisMachine()
        ? { href: "/settings/license", label: "Licence" }
        : { href: "/billing", label: "Billing" },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Business details, branding, document defaults, sending, payments and your licence."
      />
      <SettingsNav tabs={tabs} />
      <div className="max-w-3xl">{children}</div>
    </div>
  );
}

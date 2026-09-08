import { LicenseBanner } from "@/components/app-shell/license-banner";
import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { requireContext } from "@/lib/auth";
import { licenseState } from "@/lib/license/status";
import { NAVIGATION, orgLabels, resolveNavigation } from "@/lib/navigation";
import { can } from "@/lib/permissions";
import { hexToRgbChannels, initials } from "@/lib/utils";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, org } = await requireContext();

  // Navigation is filtered by role here, and every page re-checks its own
  // permission — hiding a link is presentation, not access control.
  const groups = resolveNavigation(
    NAVIGATION.map((group) => ({
      ...group,
      items: group.items.filter((item) => can(user, item.permission)),
    })).filter((group) => group.items.length > 0),
    orgLabels(org),
  );

  // The organization's saved colors become the CSS variables the whole design
  // system reads, so re-skinning for a prospect is a settings change.
  const brandRgb = hexToRgbChannels(org.primaryColor);
  const accentRgb = hexToRgbChannels(org.accentColor);
  const themeVars = {
    ...(brandRgb ? { "--brand": org.primaryColor } : {}),
    ...(accentRgb ? { "--accent": org.accentColor } : {}),
  } as React.CSSProperties;

  return (
    <div style={themeVars} className="min-h-screen">
      <Sidebar
        groups={groups}
        brand={{
          name: org.name,
          logoUrl: org.logoUrl,
          initials: initials(org.name) || "WS",
        }}
      />

      <div className="lg:pl-64 print:pl-0">
        <Topbar
          user={{
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            avatarUrl: user.avatarUrl,
          }}
          canOpenSettings={can(user, "settings:read")}
          searchPlaceholder={`Search ${org.labelClientPlural.toLowerCase()}, ${org.labelJobPlural.toLowerCase()}, invoices…`}
        />

        <LicenseBanner
          state={licenseState(org.licenseKey)}
          canActivate={can(user, "settings:write")}
        />

        <main className="mx-auto w-full max-w-7xl px-4 py-6 lg:px-6 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

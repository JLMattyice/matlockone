import { LicenseBanner } from "@/components/app-shell/license-banner";
import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { requireContext } from "@/lib/auth";
import { DemoBanner } from "@/components/app-shell/demo-banner";
import { unreadMessageCount } from "@/lib/conversations";
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

  // A badge is not worth a page. If the count cannot be read — a database
  // that has not had the messages tables added yet, say — every screen still
  // renders, just without the number.
  const unreadMessages = can(user, "messages:use")
    ? await unreadMessageCount(org.id, user).catch((error: unknown) => {
        console.error("Could not count unread messages", error);
        return 0;
      })
    : null;

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
        unreadMessages={unreadMessages}
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

        {/* In the demo, what matters is that nothing is kept; its licence
            state is nobody's business. */}
        {org.isDemo ? (
          <DemoBanner />
        ) : (
          <LicenseBanner
            state={licenseState(org.licenseKey)}
            canActivate={can(user, "settings:write")}
          />
        )}

        <main className="mx-auto w-full max-w-7xl px-4 py-6 lg:px-6 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

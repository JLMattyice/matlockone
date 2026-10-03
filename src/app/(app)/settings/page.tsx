import type { Metadata } from "next";

import { BusinessForm } from "./business-form";
import { RequestsCard } from "./requests-card";

import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { formatIn } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "Business settings" };

export default async function BusinessSettingsPage() {
  const { user, org } = await requirePermission("settings:read");
  const zone = await viewerTimeZone();

  return (
    <div className="space-y-6">
    <BusinessForm
      values={{
        name: org.name,
        legalName: org.legalName,
        email: org.email,
        phone: org.phone,
        website: org.website,
        addressLine1: org.addressLine1,
        addressLine2: org.addressLine2,
        city: org.city,
        state: org.state,
        postalCode: org.postalCode,
        country: org.country,
        timeZone: org.timeZone,
        currency: org.currency,
        locale: org.locale,
        readOnly: !can(user, "settings:write"),
      }}
    />

      <RequestsCard
        slug={org.slug}
        enabled={org.requestsEnabled}
        brandColor={org.primaryColor}
        writable={can(user, "settings:write")}
      />

      <BuildStamp zone={zone} />
    </div>
  );
}

/**
 * Which build is actually running.
 *
 * Small print, but it answers the question that is otherwise unanswerable
 * from inside the app: whether the copy in front of you is the one a fix went
 * into, or a version installed weeks ago.
 */
function BuildStamp({ zone }: { zone: string }) {
  const built = process.env.BUILD_TIME;
  if (!built) return null;

  const when = new Date(built);
  if (Number.isNaN(when.getTime())) return null;

  return (
    <p className="text-center text-xs text-ink-subtle">
      Matlock One {process.env.BUILD_VERSION} · built{" "}
      <time dateTime={built}>{formatIn(when, "d MMM yyyy, HH:mm", zone)}</time>
    </p>
  );
}

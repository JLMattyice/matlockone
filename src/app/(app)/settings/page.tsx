import type { Metadata } from "next";

import { BusinessForm } from "./business-form";
import { format } from "date-fns";

import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Business settings" };

export default async function BusinessSettingsPage() {
  const { user, org } = await requirePermission("settings:read");

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

      <BuildStamp />
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
function BuildStamp() {
  const built = process.env.BUILD_TIME;
  if (!built) return null;

  const when = new Date(built);
  if (Number.isNaN(when.getTime())) return null;

  return (
    <p className="text-center text-xs text-ink-subtle">
      Matlock One {process.env.BUILD_VERSION} · built{" "}
      <time dateTime={built}>{format(when, "d MMM yyyy, HH:mm")}</time>
    </p>
  );
}

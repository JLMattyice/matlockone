import type { Metadata } from "next";

import { CalendarFeedCard } from "./calendar-feed-card";
import { PasswordForm, ProfileForm } from "./profile-forms";
import { PushCard } from "./push-card";
import { requireContext } from "@/lib/auth";
import { feedAddresses } from "@/lib/calendar-feed-server";
import { dataStaysOnThisMachine } from "@/lib/config";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { pushKeys } from "@/lib/push";

export const metadata: Metadata = { title: "Your profile" };

export default async function ProfileSettingsPage() {
  const { user, org } = await requireContext();

  // Not on the session user: the token is a credential, and the session is
  // read on every request by every page that never needs it.
  // Only offered where the keys are set; never in the desktop app.
  const push = dataStaysOnThisMachine() ? null : pushKeys();

  const feed = can(user, "schedule:read")
    ? await prisma.user.findUnique({
        where: { id: user.id },
        select: { calendarFeedToken: true },
      })
    : null;

  return (
    <div className="space-y-6">
      <ProfileForm
        values={{
          name: user.name,
          email: user.email,
          phone: user.phone,
          position: user.position,
          role: user.role,
        }}
      />
      {feed ? (
        <CalendarFeedCard
          addresses={
            feed.calendarFeedToken ? feedAddresses(feed.calendarFeedToken) : null
          }
          canSeeAll={can(user, "jobs:read:all")}
          jobPlural={org.labelJobPlural}
          businessName={org.name}
          online={!dataStaysOnThisMachine()}
        />
      ) : null}
      {push ? <PushCard publicKey={push.publicKey} /> : null}
      <PasswordForm />
    </div>
  );
}

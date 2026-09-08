import type { Metadata } from "next";

import { PasswordForm, ProfileForm } from "./profile-forms";
import { requireContext } from "@/lib/auth";

export const metadata: Metadata = { title: "Your profile" };

export default async function ProfileSettingsPage() {
  const { user } = await requireContext();

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
      <PasswordForm />
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

import { ResetForm } from "./reset-form";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { userForResetToken } from "@/lib/password-reset";

// no-referrer: the token is in this page's address, and nothing it loads
// should be handed that address.
export const metadata: Metadata = { title: "Choose a new password", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

/**
 * Where the emailed link lands. The link is checked before the form is shown,
 * so somebody holding an old one is told at once instead of after typing a
 * new password twice.
 */
export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const user = await userForResetToken(token);

  return (
    <Card>
      <CardBody className="space-y-6 p-6 sm:p-8">
        {user ? (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold text-ink">Choose a new password</h1>
              <p className="text-sm text-ink-muted">
                For <span className="font-medium text-ink">{user.email}</span>. Every device
                signed in with the old password will be signed out.
              </p>
            </div>
            <ResetForm token={token} email={user.email} />
          </>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold text-ink">This link can’t be used</h1>
              <p className="text-sm text-ink-muted">
                It has expired or has already been used. Reset links work once, for an hour.
              </p>
            </div>
            <Link
              href="/forgot-password"
              className={buttonClasses("primary", "lg", "w-full justify-center")}
            >
              Send a new link
            </Link>
          </>
        )}
      </CardBody>
    </Card>
  );
}

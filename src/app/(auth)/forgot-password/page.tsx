import type { Metadata } from "next";
import Link from "next/link";

import { ForgotForm } from "./forgot-form";
import { Card, CardBody } from "@/components/ui/card";
import { systemMailer } from "@/lib/checkout/deliver";
import { dataStaysOnThisMachine } from "@/lib/config";
import { readRememberedEmail } from "@/lib/remembered-email";

export const metadata: Metadata = { title: "Reset your password" };
export const dynamic = "force-dynamic";

/**
 * "Forgot password?" — asks for the email and sends a link to it.
 *
 * Says up front when a link cannot be sent, rather than taking the address
 * and sending nothing: a desktop install that keeps its own data has no
 * mailbox of Matlock's to send from (it resets from the launcher instead), and
 * a hosted deployment without SYSTEM_MAIL_* has not been given one yet.
 */
export default async function ForgotPasswordPage() {
  const local = dataStaysOnThisMachine();
  const canEmail = !local && systemMailer() !== null;

  return (
    <Card>
      <CardBody className="space-y-6 p-6 sm:p-8">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-ink">Reset your password</h1>
          {canEmail ? (
            <p className="text-sm text-ink-muted">
              Enter the email you sign in with and we’ll send you a link to choose a new
              password.
            </p>
          ) : null}
        </div>

        {local ? (
          <p className="text-sm text-ink-muted">
            On this computer, open the Matlock One menu and choose{" "}
            <span className="font-medium text-ink">File → Reset a password…</span>. An owner
            or administrator can also reset anyone on the team from the Team page.
          </p>
        ) : canEmail ? (
          <ForgotForm defaultEmail={await readRememberedEmail()} />
        ) : (
          <p className="text-sm text-ink-muted">
            Password reset by email isn’t set up on this site yet. Ask the owner of your
            business to reset it for you from the Team page.
          </p>
        )}

        <p className="text-center text-sm text-ink-muted">
          <Link href="/login" className="font-medium text-brand hover:underline">
            Back to sign in
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}

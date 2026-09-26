import type { Metadata } from "next";
import Link from "next/link";

import { SignupForm } from "./signup-form";
import { Card, CardBody } from "@/components/ui/card";
import { dataStaysOnThisMachine, signupOpen } from "@/lib/config";
import { isFirstRun } from "@/lib/first-run";

export function generateMetadata(): Metadata {
  return { title: signupOpen() ? "Create workspace" : "Sign-ups closed" };
}

/**
 * Never prerendered.
 *
 * This page asks the database a question whose answer changes after the build:
 * whether this installation has any users yet. Statically rendered, the answer
 * gets frozen at build time — so a deployment seeded an hour after it shipped
 * would keep insisting it was brand new until something happened to redeploy
 * it, and a desktop build would carry whatever was true on the machine that
 * packaged it.
 *
 * It also has to be said out loud rather than left to Next to infer. The
 * database call happens before anything that reads a cookie, so prerendering
 * begins, reaches Prisma, and fails there — on a clean checkout with no
 * database file, that is a build error rather than a page.
 */
export const dynamic = "force-dynamic";

/**
 * The reassurance under the heading is different on the two builds, and it has
 * to be, because it is a claim about where the customer's records end up.
 *
 * "Everything stays on this computer" is true of a desktop install and false of
 * a hosted deployment — where it was being shown to every visitor, as the first
 * sentence they read, on the one screen that asks them to hand over their
 * business. So the promise is derived from where the data actually goes rather
 * than written into the copy.
 */
function firstRunBlurb(local: boolean) {
  return local
    ? "Set up your business to get started. Everything stays on this computer."
    : "Set up your business to get started. You will be its owner, and can invite your team once you are in.";
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  const first = await isFirstRun();
  const local = dataStaysOnThisMachine();

  // Shut, this explains itself instead of redirecting. Somebody arrives here
  // from a link and needs to know why there is no form, and /login already
  // sends an empty installation back here, so a redirect would be a loop.
  if (!signupOpen()) {
    return (
      <Card>
        <CardBody className="space-y-4 p-6 sm:p-8">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold text-ink">Sign-ups are closed</h1>
            <p className="text-sm text-ink-muted">
              Accounts here are added by the workspace owner. Ask them to add
              you under Team, then sign in.
            </p>
          </div>
          {first ? null : (
            <p className="text-sm">
              <Link href="/login" className="font-medium text-brand hover:underline">
                Sign in
              </Link>
            </p>
          )}
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-6 p-6 sm:p-8">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-ink">
            {first ? "Welcome to Matlock One" : "Create your workspace"}
          </h1>
          <p className="text-sm text-ink-muted">
            {first
              ? firstRunBlurb(local)
              : "Sets up your organization and makes you its owner."}
          </p>
        </div>

        {from === "demo" ? (
          // Said before they start, so nobody goes looking for the demo's
          // records in their new workspace.
          <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-ink-muted">
            Your workspace starts empty. Nothing from the demo comes with it.
          </p>
        ) : null}

        <SignupForm offerSignIn={!first} />
      </CardBody>
    </Card>
  );
}

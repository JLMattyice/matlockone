import type { Metadata } from "next";

import { SignupForm } from "./signup-form";
import { Card, CardBody } from "@/components/ui/card";
import { dataStaysOnThisMachine } from "@/lib/config";
import { isFirstRun } from "@/lib/first-run";

export const metadata: Metadata = { title: "Create workspace" };

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

export default async function SignupPage() {
  const first = await isFirstRun();
  const local = dataStaysOnThisMachine();

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

        <SignupForm />
      </CardBody>
    </Card>
  );
}

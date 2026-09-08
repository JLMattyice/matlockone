import type { Metadata } from "next";

import { SignupForm } from "./signup-form";
import { Card, CardBody } from "@/components/ui/card";
import { isFirstRun } from "@/lib/first-run";

export const metadata: Metadata = { title: "Create workspace" };

export default async function SignupPage() {
  const first = await isFirstRun();

  return (
    <Card>
      <CardBody className="space-y-6 p-6 sm:p-8">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-ink">
            {first ? "Welcome to Matlock One" : "Create your workspace"}
          </h1>
          <p className="text-sm text-ink-muted">
            {first
              ? "Set up your business to get started. Everything stays on this computer."
              : "Sets up your organization and makes you its owner."}
          </p>
        </div>

        <SignupForm />
      </CardBody>
    </Card>
  );
}

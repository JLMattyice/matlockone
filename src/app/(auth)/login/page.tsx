import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LoginForm } from "./login-form";
import { Card, CardBody } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { isFirstRun } from "@/lib/first-run";
import { readRememberedEmail } from "@/lib/remembered-email";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Nobody has set this copy up yet: send them to do that rather than to a
  // sign-in form with no account behind it.
  if (await isFirstRun()) redirect("/signup");

  const { next } = await searchParams;
  const rememberedEmail = await readRememberedEmail();

  // The seeded demo account is advertised only while it still exists, so a real
  // deployment never shows credentials on its sign-in screen.
  const demo = await prisma.user.findFirst({
    where: { email: "owner@demo.test" },
    select: { email: true },
  });

  return (
    <Card>
      <CardBody className="space-y-6 p-6 sm:p-8">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-ink">Sign in</h1>
          <p className="text-sm text-ink-muted">
            Welcome back. Enter your details to continue.
          </p>
        </div>

        <LoginForm next={next} rememberedEmail={rememberedEmail} />

        {demo ? (
          <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-xs text-ink-muted">
            <span className="font-medium text-ink">Demo account</span>
            <br />
            owner@demo.test · demo1234
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

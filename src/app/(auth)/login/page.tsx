import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LoginForm } from "./login-form";
import { Card, CardBody } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { isFirstRun } from "@/lib/first-run";
import { readRememberedEmail } from "@/lib/remembered-email";

export const metadata: Metadata = { title: "Sign in" };

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

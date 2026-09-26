import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { leaveDemoForSignup } from "./actions";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { requireContext } from "@/lib/auth";

export const metadata: Metadata = { title: "This is a demo" };

/**
 * Where a demo visitor lands after trying to save anything.
 *
 * requireContext() sends every save from the demo here instead of running it,
 * so this page is the demo's answer to all of them — a new job, an invoice, a
 * note, a changed setting. It says what happened and offers both ways on:
 * back to where they were, or to an account of their own.
 */
export default async function DemoRefusedPage({
  searchParams,
}: {
  searchParams: Promise<{ back?: string }>;
}) {
  const { org } = await requireContext();

  // Only the demo refuses saves. Anybody else here followed an old link.
  if (!org.isDemo) redirect("/dashboard");

  const { back } = await searchParams;
  // Same-site paths only; the value came through a URL and could be anything.
  const returnTo =
    back && back.startsWith("/") && !back.startsWith("//") ? back : "/dashboard";

  return (
    <div className="mx-auto max-w-lg py-8">
      <Card>
        <CardBody className="space-y-5 p-6 text-center sm:p-8">
          <div className="space-y-2">
            <h1 className="text-lg font-semibold text-ink">
              This is a demo, so nothing was saved
            </h1>
            <p className="text-sm text-ink-muted">
              {org.name} is a sample business for looking around. Everything
              opens and every form works, but no change is kept — so it looks
              the same for the next person.
            </p>
            <p className="text-sm text-ink-muted">
              To keep your work, create your own account. It starts empty and
              belongs to you.
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-3">
            <form action={leaveDemoForSignup}>
              <button type="submit" className={buttonClasses("primary", "md")}>
                Create your account
              </button>
            </form>
            <Link href={returnTo} className={buttonClasses("outline", "md")}>
              Keep looking around
            </Link>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

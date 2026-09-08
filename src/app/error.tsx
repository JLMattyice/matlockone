"use client";

import { useEffect } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";

/**
 * The safety net for everything outside the signed-in app: the login and
 * signup screens, the public estimate and invoice links, and the root.
 *
 * Without one, a failure on any of those falls through to Next's own page,
 * which reads "Application error: a server-side exception has occurred" over a
 * blank white screen — the worst possible thing for a client who followed an
 * invoice link to put money in someone's hands. This at least looks like the
 * business's own software and gives them a reference to quote.
 *
 * The signed-in app has its own boundary at (app)/error.tsx, which offers a way
 * back to the dashboard. This one cannot assume the reader has an account.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The full stack is in the server log, matched by this digest — see
    // src/instrumentation.ts.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-screen max-w-lg items-center px-4">
      <Card className="w-full">
        <EmptyState
          icon={<TriangleAlert className="h-5 w-5" strokeWidth={1.75} />}
          title="Something went wrong"
          description={
            error.digest
              ? `This page could not be loaded. If you contact us, quote reference ${error.digest}.`
              : "This page could not be loaded."
          }
          action={
            <div className="flex gap-2">
              <Button onClick={reset}>Try again</Button>
              <Link href="/" className={buttonClasses("outline", "md")}>
                Start over
              </Link>
            </div>
          }
        />
      </Card>
    </div>
  );
}

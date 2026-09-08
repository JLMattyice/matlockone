"use client";

import { useEffect } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";

/**
 * Safety net for unexpected server errors. Permission failures do not reach
 * here — `requirePermission` redirects to /no-access instead, because a client
 * error boundary only receives a digest in production and could not tell an
 * authorization failure from a crash.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg pt-10">
      <Card>
        <EmptyState
          icon={<TriangleAlert className="h-5 w-5" strokeWidth={1.75} />}
          title="Something went wrong"
          description={
            error.digest
              ? `The page could not be loaded. Reference: ${error.digest}`
              : "The page could not be loaded."
          }
          action={
            <div className="flex gap-2">
              <Button onClick={reset}>Try again</Button>
              <Link href="/dashboard" className={buttonClasses("outline", "md")}>
                Back to dashboard
              </Link>
            </div>
          }
        />
      </Card>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Hourglass } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";
import { requireContext } from "@/lib/auth";
import { retryAfterPhrase, SAVES_PER_USER } from "@/lib/rate-limit";

export const metadata: Metadata = { title: "Too many saves" };

/**
 * Where somebody lands after saving faster than SAVES_PER_USER allows — in
 * practice only a script, or something stuck resubmitting. The wait comes in
 * the address as a number and is only ever used as one.
 */
export default async function SlowDownPage({
  searchParams,
}: {
  searchParams: Promise<{ wait?: string }>;
}) {
  await requireContext();
  const { wait } = await searchParams;
  const seconds = Math.min(Math.max(Number(wait) || 60, 1), SAVES_PER_USER.windowSeconds);

  return (
    <div className="mx-auto max-w-lg pt-10">
      <Card>
        <EmptyState
          icon={<Hourglass className="h-5 w-5" strokeWidth={1.75} />}
          title="That’s a lot of saving at once"
          description={`To keep Matlock One quick for every business, saving pauses for a while when one person saves more than ${SAVES_PER_USER.limit} times in ${SAVES_PER_USER.windowSeconds / 60} minutes. Everything saved before now is safe. You can save again ${retryAfterPhrase(seconds)}.`}
          action={
            <Link href="/dashboard" className={buttonClasses("primary", "md")}>
              Back to dashboard
            </Link>
          }
        />
      </Card>
    </div>
  );
}

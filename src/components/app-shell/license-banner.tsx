import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { daysRemaining, type LicenseState } from "@/lib/license/status";

/**
 * The line above the work when a licence key is close to running out.
 *
 * Deliberately a line rather than a dialog over the work: this is a
 * commercial fact, not an error, and interrupting someone mid-invoice to sell
 * them something is how software gets resented. It never appears for a
 * healthy licence — a permanent banner is one people stop seeing — and a
 * business without a valid one never reaches the application to see it.
 */
export function LicenseBanner({
  state,
  canActivate,
}: {
  state: LicenseState;
  canActivate: boolean;
}) {
  const remaining = daysRemaining(state);

  // Quiet until renewal is genuinely close.
  if (state.kind !== "licensed" || remaining === null || remaining > 14) {
    return null;
  }

  return (
    <div className="border-b border-warning/25 bg-warning/10 px-4 py-2.5 lg:px-6 print:hidden">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-sm text-warning">
          Your licence expires in {remaining} {remaining === 1 ? "day" : "days"}.
          Enter the renewed key before then to keep the account open.
        </p>

        {canActivate ? (
          <Link
            href="/settings/license"
            className={buttonClasses("outline", "sm", "ml-auto")}
          >
            Renew
          </Link>
        ) : (
          <p className="ml-auto text-sm text-ink-subtle">
            Ask an owner or administrator.
          </p>
        )}
      </div>
    </div>
  );
}

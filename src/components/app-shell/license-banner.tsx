import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { DEMO_SEATS, daysRemaining, type LicenseState } from "@/lib/license/status";

/**
 * The one place the application says it is not fully licensed.
 *
 * Deliberately a line above the work rather than a dialog over it: this is a
 * commercial fact, not an error, and interrupting someone mid-invoice to sell
 * them something is how software gets resented. It also never appears for a
 * healthy licence — a permanent banner is one people stop seeing.
 */
export function LicenseBanner({
  state,
  canActivate,
}: {
  state: LicenseState;
  canActivate: boolean;
}) {
  const remaining = daysRemaining(state);

  // A licensed workspace stays quiet until renewal is genuinely close.
  if (state.kind === "licensed" && (remaining === null || remaining > 14)) {
    return null;
  }

  const expiring = state.kind === "licensed";

  const message = expiring
    ? `Your licence expires in ${remaining} ${remaining === 1 ? "day" : "days"}.`
    : state.reason === "expired"
      ? "Your licence has expired. The workspace is running with demo limits."
      : state.reason
        ? `${state.message} Running with demo limits.`
        : `Demo mode — everything works, up to ${DEMO_SEATS} active people.`;

  return (
    <div
      className={`border-b px-4 py-2.5 lg:px-6 print:hidden ${
        expiring || state.reason
          ? "border-warning/25 bg-warning/10"
          : "border-line bg-surface-3"
      }`}
    >
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-3 gap-y-2">
        <p
          className={`text-sm ${expiring || state.reason ? "text-warning" : "text-ink-muted"}`}
        >
          {message}
        </p>

        {canActivate ? (
          <Link
            href="/settings/license"
            className={buttonClasses("outline", "sm", "ml-auto")}
          >
            {expiring ? "Renew" : "Enter licence key"}
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

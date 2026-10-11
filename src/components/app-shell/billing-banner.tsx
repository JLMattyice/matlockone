import { format } from "date-fns";
import Link from "next/link";

import { LicenseBanner } from "./license-banner";
import { entitlement, GRACE_DAYS, type BillingFields } from "@/lib/billing/entitlement";
import { licenseState } from "@/lib/license/status";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The line above the work when a plan is about to stop.
 *
 * Quiet otherwise. A business that is paid up hears nothing about billing, and
 * one that is not paid up never sees the application at all — so this only
 * ever speaks in the days a plan is running out: cancelled and running to the
 * end of its month, a payment PayPal could not take, a licence near expiry —
 * and through a free month from a code that has no plan to follow it yet,
 * since that one ends by itself unless somebody acts.
 */
export function BillingBanner({
  org,
  canManage,
}: {
  org: BillingFields & { subscriptionId?: string | null; trialEndsAt?: Date | null };
  canManage: boolean;
}) {
  const access = entitlement(org);
  if (!access.ok) return null;

  if (access.via === "licence") {
    return <LicenseBanner state={licenseState(org.licenseKey)} canActivate={canManage} />;
  }

  if (access.via !== "subscription" || !org.paidThrough) return null;

  if (org.trialEndsAt && !org.subscriptionId && org.trialEndsAt > new Date()) {
    return (
      <div className="border-b border-brand/30 bg-brand/10 print:hidden">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 lg:px-6">
          <p className="text-sm text-ink">
            {`Your free month runs until ${format(org.trialEndsAt, "MMMM d")}.`}
            {canManage ? " Choose a plan before then to keep going." : null}
          </p>
          {canManage ? (
            <Link href="/billing" className="text-sm font-medium text-brand hover:underline">
              Choose a plan
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  const message =
    org.subscriptionStatus === "CANCELLED"
      ? `Your plan is cancelled and stays open until ${format(org.paidThrough, "MMMM d")}.`
      : org.subscriptionStatus === "SUSPENDED"
        ? `PayPal couldn’t take your last payment. Update it before ${format(
            new Date(org.paidThrough.getTime() + GRACE_DAYS * DAY_MS),
            "MMMM d",
          )} to keep your account open.`
        : null;

  if (!message) return null;

  return (
    <div className="border-b border-warning/30 bg-warning/10 print:hidden">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 lg:px-6">
        <p className="text-sm text-ink">{message}</p>
        {canManage ? (
          <Link href="/billing" className="text-sm font-medium text-brand hover:underline">
            Billing
          </Link>
        ) : null}
      </div>
    </div>
  );
}

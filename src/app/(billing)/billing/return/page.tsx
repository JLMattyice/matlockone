import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { requireContext } from "@/lib/auth";
import { BILLING_PATH, entitlement } from "@/lib/billing/entitlement";
import { syncSubscription } from "@/lib/billing/subscription";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Finishing with PayPal" };
export const dynamic = "force-dynamic";

/** How many times the page checks again before saying it is taking a while. */
const MAX_TRIES = 20;

/**
 * Where PayPal sends somebody after they approve a plan.
 *
 * The subscription id in the address is only a hint of which one to look at.
 * What it is worth is asked of PayPal, and it must have been started for the
 * business signed in here — so an id copied from somebody else's return link
 * opens nothing.
 *
 * PayPal usually activates a subscription within seconds of approval, but not
 * always before the buyer is back. Until it does, this page checks again every
 * few seconds, and the webhook will get there regardless.
 */
export default async function BillingReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ subscription_id?: string; try?: string }>;
}) {
  const { org } = await requireContext({ unpaid: "allow" });

  const params = await searchParams;
  const subscriptionId = params.subscription_id ?? org.subscriptionId;
  if (!subscriptionId) redirect(BILLING_PATH);

  const synced = await syncSubscription(subscriptionId, { expectOrganizationId: org.id });

  if (synced.linked) {
    const updated = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    if (entitlement(updated).ok) redirect("/dashboard?welcome=1");
  }

  const tries = Math.max(0, Number(params.try) || 0);
  const waiting = synced.linked && tries < MAX_TRIES;
  const next = `${BILLING_PATH}/return?subscription_id=${encodeURIComponent(subscriptionId)}&try=${tries + 1}`;

  return (
    <div className="mx-auto max-w-lg py-8">
      {/* React places this in the document head. A plain refresh, so it works
          without anything else on the page having to run. */}
      {waiting ? <meta httpEquiv="refresh" content={`3;url=${next}`} /> : null}

      <Card>
        <CardBody className="space-y-4 p-6 text-center sm:p-8">
          {waiting ? (
            <>
              <h1 className="text-lg font-semibold text-ink">Finishing up with PayPal…</h1>
              <p className="text-sm text-ink-muted">
                Your plan is approved and PayPal is starting it. This page moves on by
                itself in a few seconds.
              </p>
            </>
          ) : synced.linked ? (
            <>
              <h1 className="text-lg font-semibold text-ink">PayPal is taking a while</h1>
              <p className="text-sm text-ink-muted">
                Your plan was approved, but PayPal hasn’t started it yet. It usually takes
                a minute. You can leave this page — the account opens by itself as soon as
                PayPal confirms.
              </p>
              <Link href={next} className={buttonClasses("outline", "md")}>
                Check again
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-ink">We couldn’t confirm that plan</h1>
              <p className="text-sm text-ink-muted">
                {synced.reason === "unreachable"
                  ? "PayPal didn’t answer just now. If it took a payment, the account opens by itself within a few minutes."
                  : "That subscription isn’t one this account started. Choose a plan from the billing page to carry on."}
              </p>
              <Link href={BILLING_PATH} className={buttonClasses("outline", "md")}>
                Back to billing
              </Link>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { prisma } from "@/lib/db";

export const metadata: Metadata = {
  title: { absolute: "Thank you — Matlock One" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Where PayPal sends a buyer after they approve.
 *
 * The key is shown here rather than only emailed. Nothing in this codebase
 * sends a buyer their licence yet, and a page that says "check your inbox" when
 * no message is coming is the worst possible end to a purchase. Showing it also
 * removes an entire category of support: mail that lands in spam, is typo'd, or
 * goes to an address the buyer no longer reads.
 *
 * Addressed by PayPal's subscription id, which arrives in the redirect and is
 * unguessable — the same "the link is the credential" arrangement the
 * client-facing estimate and invoice pages already use.
 */
export default async function CheckoutThanksPage({
  searchParams,
}: {
  searchParams: Promise<{ subscription_id?: string }>;
}) {
  const { subscription_id: subscriptionId } = await searchParams;

  const purchase = subscriptionId
    ? await prisma.purchase.findUnique({
        where: {
          provider_externalId: {
            provider: "PAYPAL",
            externalId: subscriptionId,
          },
        },
      })
    : null;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-24 lg:px-8 lg:py-32">
      <h1 className="display text-4xl text-ink sm:text-5xl">
        Thank you — you&rsquo;re subscribed.
      </h1>

      {purchase?.licenseKey ? (
        <>
          <p className="mt-6 text-ink-muted">
            Here is your licence key. Open Matlock One, go to Settings →
            Licence, and paste it in. Everything you have already entered stays
            exactly where it is.
          </p>

          <div className="mt-6 rounded-xl border border-line bg-surface-2 p-5">
            <p className="text-xs tracking-[0.16em] text-ink-subtle uppercase">
              Your licence key
            </p>
            <p className="mt-3 font-mono text-xs leading-relaxed break-all text-ink">
              {purchase.licenseKey}
            </p>
          </div>

          <p className="mt-4 text-sm text-ink-subtle">
            Keep this page, or copy the key somewhere safe. It covers{" "}
            {purchase.seats === null
              ? "unlimited people"
              : `${purchase.seats} ${purchase.seats === 1 ? "person" : "people"}`}{" "}
            on the {purchase.plan} plan.
          </p>
        </>
      ) : (
        <>
          <p className="mt-6 text-ink-muted">
            PayPal has confirmed your subscription and your licence is being
            issued. It usually takes a few seconds — refresh this page and it
            will appear here.
          </p>
          <p className="mt-4 text-sm text-ink-subtle">
            If it still is not here in a minute, get in touch with the email
            address you subscribed under and we will send your key directly.
            Your payment is safe either way; nothing is lost.
          </p>
        </>
      )}

      <div className="mt-10 flex flex-wrap gap-3">
        <a href="/#download" className={buttonClasses("primary", "lg")}>
          Download Matlock One
        </a>
        <Link href="/" className={buttonClasses("outline", "lg")}>
          Back to the site
        </Link>
      </div>
    </div>
  );
}

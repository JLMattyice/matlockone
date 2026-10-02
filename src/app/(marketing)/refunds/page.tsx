import type { Metadata } from "next";
import Link from "next/link";

import { LegalList, LegalPage, LegalSection } from "../legal-page";
import { GRACE_DAYS } from "@/lib/billing/entitlement";
import { LEGAL_EMAIL } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Refund Policy",
  description: "How paying for Matlock One, cancelling and refunds work.",
};

/**
 * What happens to money paid for Matlock One.
 *
 * Written to match what billing actually does, not what billing policies
 * usually say: a cancelled plan stays open to the end of what was paid for
 * (subscription.ts, paidThroughFor), a missed payment has GRACE_DAYS before
 * the workspace locks (entitlement.ts), and nothing is deleted when a plan
 * ends. The business chose "cancel any time, no refunds" on 2026-10-01.
 */
export default function RefundPolicyPage() {
  return (
    <LegalPage
      title="Refund Policy"
      path="/refunds"
      summary={[
        "You pay in advance, monthly or yearly, through PayPal. Your plan renews by itself until you cancel.",
        "Cancel any time from the Billing page. No more payments are taken, and your workspace stays open until the end of the time you’ve paid for.",
        "We don’t refund unused time. We always refund our mistakes, such as being charged twice.",
        "A plan ending never deletes anything. Choose a plan again and everything is where you left it.",
      ]}
    >
      <LegalSection id="paying" title="How you pay">
        <p>
          Matlock One is paid for in advance, monthly or yearly, through PayPal. There is no free
          plan; the demo lets you look around first. Your plan renews automatically at the end of
          each period until you cancel it.
        </p>
        <p>
          If we ever change the price of your plan, we’ll tell you at least 30 days before your
          first payment at the new price.
        </p>
      </LegalSection>

      <LegalSection id="cancelling" title="Cancelling">
        <p>
          Anyone who manages billing for your business can cancel from the Billing page in
          Matlock One, or from your PayPal account. Once you cancel:
        </p>
        <LegalList
          items={[
            "No further payments are taken.",
            "Your workspace stays fully open until the end of the period you’ve paid for.",
            "After that it locks: nobody on your team can use it until a plan is chosen again. Nothing is deleted.",
            "You can choose a plan again at any time. If you still have paid time left, the new plan starts when that time runs out, so you’re never charged twice for the same days.",
          ]}
        />
      </LegalSection>

      <LegalSection id="refunds" title="Refunds">
        <p>
          Because you can cancel whenever you like and keep everything you’ve paid for, we don’t
          refund:
        </p>
        <LegalList
          items={[
            "the unused part of a month or a year,",
            "the remaining months of a yearly plan,",
            "moving to a smaller plan partway through a period, or",
            "time when the workspace was open but not used.",
          ]}
        />
        <p>
          <strong>We refund in full</strong> any charge that was our mistake: being charged twice
          for the same period, being charged after you cancelled, or any other billing error. And
          where the law that applies to you requires a refund, you’ll get one.
        </p>
      </LegalSection>

      <LegalSection id="missed-payments" title="Missed payments">
        <p>
          If a renewal payment doesn’t go through, your workspace stays open for {GRACE_DAYS} days
          after the end of the period you’d paid for, so there’s time to sort it out. After that it
          locks until a payment succeeds. Nothing is deleted while it’s locked.
        </p>
      </LegalSection>

      <LegalSection id="changing-plans" title="Changing plans">
        <p>
          Switching to a different plan changes your existing PayPal subscription, and PayPal may
          ask you to approve the new price. The new price applies from your next payment; we
          don’t charge or refund the difference for the period you’re already in.
        </p>
      </LegalSection>

      <LegalSection id="licence-keys" title="Licence keys">
        <p>
          If your business uses Matlock One with a licence key instead of a subscription, the key
          covers the plan and period it was issued for. The same rule applies: a mistake on our
          part is refunded, unused time is not.
        </p>
      </LegalSection>

      <LegalSection id="your-customers" title="Payments your customers make to you">
        <p>
          When your customers pay you through a Pay now link, the money goes straight to your own
          payment account — PayPal, Stripe, Square or whichever you’ve connected. Matlock One
          never holds it, so refunds to your customers are made from that account, not by us.
        </p>
      </LegalSection>

      <LegalSection id="asking" title="How to ask for a refund">
        <p>
          Email <a href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a> with your business name, the
          email address you sign in with, and the PayPal transaction ID if you have it. We reply
          within five business days, and approved refunds go back through PayPal to the way you
          paid.
        </p>
        <p>
          This policy is part of our <Link href="/terms">Terms of Service</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

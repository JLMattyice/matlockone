import type { Metadata } from "next";
import Link from "next/link";

import { LegalList, LegalPage, LegalSection } from "../legal-page";
import { GRACE_DAYS } from "@/lib/billing/entitlement";
import {
  LEGAL_CITY,
  LEGAL_COUNTY,
  LEGAL_EMAIL,
  LEGAL_NAME,
  LEGAL_STATE,
} from "@/lib/legal";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The agreement between Matlock Software Development and the businesses that use Matlock One.",
};

/**
 * The agreement a business accepts by signing up.
 *
 * Plain English by choice: the people agreeing to it run landscaping crews
 * and cleaning companies, and a term nobody can follow protects nobody.
 * Anything said here about billing has to match the billing code — see the
 * Refund Policy page, which states those mechanics in full.
 */
export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      path="/terms"
      summary={[
        "This is an agreement between your business and Matlock Software Development, under Tennessee law.",
        "You own your business’s data. We use it only to run Matlock One for you, and we never sell it.",
        "You pay in advance, can cancel any time, and keep access to the end of what you paid for. Unused time isn’t refunded.",
        "Use it lawfully: no spam, no getting into anyone else’s data, no sharing access outside your business.",
        "We work hard to keep it running, but it’s provided as is, and our liability is limited to what you paid in the last 12 months.",
      ]}
    >
      <LegalSection id="agreement" title="1. Who this agreement is with">
        <p>
          Matlock One is made by {LEGAL_NAME} of {LEGAL_CITY} (“we”, “us”). These terms are an
          agreement between us and the business that uses Matlock One (“you”).
        </p>
        <p>
          Whoever creates the account or accepts these terms confirms that they are at least 18
          and allowed to agree to them on the business’s behalf. Creating an account, choosing a
          plan or using Matlock One means you accept these terms, our{" "}
          <Link href="/privacy">Privacy Policy</Link> and our{" "}
          <Link href="/refunds">Refund Policy</Link>.
        </p>
      </LegalSection>

      <LegalSection id="service" title="2. What Matlock One is">
        <p>
          Matlock One is software for running a small business: customers, jobs, scheduling,
          estimates, invoices, payments, expenses, files and team messages. It runs at
          matlockone.com, and the Windows app opens the same account. It is for business use, not
          personal or household use.
        </p>
        <p>
          The Windows app can also keep a business entirely on one computer instead of online. In
          that case your data never reaches our servers, and backing up that computer is up to you.
        </p>
      </LegalSection>

      <LegalSection id="accounts" title="3. Your account and your team">
        <LegalList
          items={[
            "Keep sign-in details private. You’re responsible for what happens under your account, including by the people you add to it.",
            "Give each person the role they need, and remove people who leave.",
            <>
              Tell us straight away at <a href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a> if you
              think someone has got into your account who shouldn’t have.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection id="payment" title="4. Plans and payment">
        <LegalList
          items={[
            "Plans are paid in advance, monthly or yearly, through PayPal, and renew automatically until you cancel. There is no free plan.",
            "Prices are listed on our website in US dollars. If we’re required to collect a sales tax, it’s added and shown before you pay.",
            "If we change the price of your plan, we’ll tell you at least 30 days before your first payment at the new price.",
            "Each plan has limits on how many people can use it and how much it can store. When storage is full, new uploads stop until you make room or move to a bigger plan.",
            `If a payment fails, your workspace stays open for ${GRACE_DAYS} days after the paid period ends, then locks until a payment goes through. Nothing is deleted.`,
            <>
              You can cancel at any time and keep access until the end of the period you’ve paid
              for. We don’t refund unused time, but we always refund our own billing mistakes. The{" "}
              <Link href="/refunds">Refund Policy</Link> has the details.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection id="your-data" title="5. Your data">
        <p>
          <strong>Everything you put into Matlock One is yours.</strong> You let us store, copy,
          process and display it only as needed to run Matlock One for you, keep it safe, and help
          you when you ask. We don’t sell it, and we don’t use it for advertising.
        </p>
        <p>
          You’re responsible for having the right to keep your customers’ information and for how
          you use it — including getting any permission the law requires before you email or text
          them, and making sure your invoices, taxes and records are correct.
        </p>
        <p>
          When a plan ends we keep your data, so you can come back to it. You can ask us to delete
          it; the <Link href="/privacy">Privacy Policy</Link> explains how.
        </p>
      </LegalSection>

      <LegalSection id="acceptable-use" title="6. Using it fairly">
        <p>You agree not to:</p>
        <LegalList
          items={[
            "use Matlock One for anything unlawful or fraudulent;",
            "send spam, or messages to people who haven’t agreed to receive them;",
            "upload malicious software, or material you don’t have the right to use;",
            "try to reach another business’s data, test or overload our systems, or get around plan limits or security;",
            "resell Matlock One, or share access with people outside your business;",
            "copy the software or take it apart to build something that competes with it, except where the law allows.",
          ]}
        />
      </LegalSection>

      <LegalSection id="other-services" title="7. Services from other companies">
        <p>
          Matlock One works with services run by other companies: PayPal for paying us, and the
          payment processor, email account and calendar apps you choose to connect. Their own
          terms apply to your use of them, and we aren’t responsible for what they do, what they
          charge, or when they’re unavailable.
        </p>
        <p>
          Payments your customers make to you go straight to your own payment account. Matlock One
          never holds your money.
        </p>
      </LegalSection>

      <LegalSection id="availability" title="8. Keeping it running, and changes">
        <p>
          We work to keep Matlock One available, secure and backed up, but we can’t promise it will
          never be interrupted, and we sometimes need to take it down briefly for maintenance. We
          also improve it over time. If we take away something you rely on, we’ll give you
          reasonable notice first.
        </p>
      </LegalSection>

      <LegalSection id="ending" title="9. Ending this agreement">
        <p>
          You can stop at any time by cancelling your plan. To close your business’s account and
          have its data deleted, write to <a href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a>.
        </p>
        <p>
          We may suspend or close an account that breaks these terms, is used for fraud or abuse,
          or isn’t paid for. Where we reasonably can, we’ll tell you first and give you a chance to
          put things right. If we ever stop offering Matlock One altogether, we’ll give at least 60
          days’ notice and a way to get a copy of your data.
        </p>
      </LegalSection>

      <LegalSection id="disclaimers" title="10. What we don’t promise">
        <p>
          <strong>
            Matlock One is provided “as is” and “as available”, without warranties of any kind
            beyond those the law requires
          </strong>
          , including any implied warranty that it is fit for a particular purpose or will be free
          of errors. It isn’t legal, tax or accounting advice. Check amounts, taxes and documents
          before you send them.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="11. Limits on our liability">
        <p>
          As far as the law allows, we aren’t liable for indirect, incidental, special,
          consequential or punitive losses, or for lost profits, revenue or data.{" "}
          <strong>
            Our total liability for all claims connected with Matlock One is limited to what you
            paid us in the 12 months before the claim arose.
          </strong>{" "}
          Nothing in these terms limits liability that the law doesn’t allow to be limited.
        </p>
      </LegalSection>

      <LegalSection id="indemnity" title="12. Claims caused by your use">
        <p>
          If someone brings a claim against us because of the data you put into Matlock One, the
          messages you send your customers through it, or your breaking these terms, you’ll cover
          our reasonable costs of dealing with it.
        </p>
      </LegalSection>

      <LegalSection id="law" title="13. Law and disputes">
        <p>
          These terms are governed by the laws of the State of {LEGAL_STATE}, without regard to its
          rules on conflicts of law. If a problem comes up, please write to us first — most things
          can be sorted out that way. Anything that can’t will be decided in the state courts of{" "}
          {LEGAL_COUNTY}, or the federal court for the Eastern District of Tennessee, and both of
          us agree to those courts.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="14. Changes to these terms">
        <p>
          We may update these terms. The date at the top always shows the latest version. For a
          change that matters, we’ll email the account owner or show a notice in Matlock One at
          least 30 days before it takes effect. Using Matlock One after that means you accept the
          new terms; if you don’t, you can cancel.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="15. Contact">
        <p>
          {LEGAL_NAME}, {LEGAL_CITY}.{" "}
          <a href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a>
        </p>
      </LegalSection>
    </LegalPage>
  );
}

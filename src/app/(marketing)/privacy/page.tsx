import type { Metadata } from "next";
import Link from "next/link";

import { LegalList, LegalPage, LegalSection } from "../legal-page";
import { LEGAL_CITY, LEGAL_EMAIL, LEGAL_NAME } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What Matlock One collects, where it goes, how long it is kept, and how to have it deleted.",
};

/**
 * What happens to information put into Matlock One.
 *
 * Every claim here was checked against the code on 2026-10-01, and has to be
 * re-checked when the code changes: the three cookies (session.ts,
 * remembered-email.ts, viewer-time-zone.ts), scrypt password hashes
 * (password.ts), AES-256-GCM for connection secrets (secret-box.ts), what a
 * session records (Session.userAgent, Session.ipAddress), what a pay link
 * sends a processor (payments/providers.ts PaymentRequest), and what a
 * calendar feed contains (calendar-feed.ts — no amounts). There is no
 * analytics or advertising code anywhere in the app; adding any means
 * changing this page in the same commit.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      path="/privacy"
      summary={[
        "We keep what you put into Matlock One so we can run it for you. We don’t sell it, advertise with it, or track you around the web.",
        "Your customers’ details belong to your business. We look after them on your behalf.",
        "It’s stored with Vercel and Supabase in the United States, and goes to other services only to do a job you asked for.",
        "Three cookies, all needed to sign you in. No analytics or advertising cookies.",
        `Ending a plan deletes nothing. To have your data deleted, email ${LEGAL_EMAIL}.`,
      ]}
    >
      <LegalSection id="who" title="1. Who we are">
        <p>
          Matlock One is run by {LEGAL_NAME} of {LEGAL_CITY} (“we”, “us”). This policy covers
          matlockone.com, the Matlock One app (on the web and for Windows), and the emails Matlock
          One sends.
        </p>
      </LegalSection>

      <LegalSection id="two-kinds" title="2. Two kinds of information">
        <p>
          <strong>About you and your team.</strong> The people who sign in to Matlock One are our
          customers, and we decide how that information is handled. This policy explains how.
        </p>
        <p>
          <strong>About your customers.</strong> The customers, jobs, invoices and other records
          you keep in Matlock One belong to your business. You decide what goes in and how it’s
          used; we store and process it on your behalf and only to run Matlock One for you. If one
          of your customers has a question about their information, they should ask you, and we’ll
          help you answer it.
        </p>
      </LegalSection>

      <LegalSection id="collect" title="3. What we collect">
        <LegalList
          items={[
            <>
              <strong>Account details:</strong> each person’s name, email address and role, the
              business’s name and details, and settings such as your time zone. Passwords are
              never stored as you type them — only as a one-way scrambled form (scrypt) that can’t
              be turned back into the password.
            </>,
            <>
              <strong>What you put in:</strong> customers, leads, jobs, schedules, estimates,
              invoices, payments, expenses, time, notes, files, photos and team messages.
            </>,
            <>
              <strong>Your customers’ signatures:</strong> when a customer accepts an estimate
              online, the name they type to sign, the time, and the internet address and browser
              they used are kept with the estimate, with a copy of what they agreed to.
            </>,
            <>
              <strong>Requests sent to you:</strong> what someone enters on your “Request service”
              form — their name, contact details, address, what they need and any photos — comes
              to you as a lead. We count requests by internet address only to stop floods.
            </>,
            <>
              <strong>Accounts you connect:</strong> the passwords and keys for the email account,
              payment processor and QuickBooks company you link to Matlock One. These are encrypted
              (AES-256-GCM) and only unlocked at the moment they’re used.
            </>,
            <>
              <strong>Billing:</strong> PayPal takes the payment for your plan, and we never see
              your card or bank details. We receive the subscription’s plan, status and payment
              dates.
            </>,
            <>
              <strong>Time on the clock:</strong> when each team member clocks in and out, and
              when they start and stop work on a job. No location is recorded.
            </>,
            <>
              <strong>Notification sign-ups:</strong> if you turn on notifications on a phone or
              browser, the address its push service gave it for them, and which browser it is.
              Turning them off deletes it.
            </>,
            <>
              <strong>Security records:</strong> each signed-in session notes the browser and IP
              address it started from, kept until the session ends. IP addresses are also counted
              briefly to stop repeated sign-in guessing. Your workspace keeps a history of
              important actions — who sent an invoice, who recorded a payment — so you can see
              what happened.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection id="cookies" title="4. Cookies">
        <p>Matlock One sets three cookies, all needed for it to work:</p>
        <LegalList
          items={[
            "one that keeps you signed in,",
            "one that remembers the email you last signed in with, to fill it in next time, and",
            "one that remembers your time zone, so times are shown on your clock.",
          ]}
        />
        <p>
          There are no analytics, advertising or tracking cookies, and nothing that follows you to
          other websites.
        </p>
      </LegalSection>

      <LegalSection id="use" title="5. How we use it">
        <p>Only to:</p>
        <LegalList
          items={[
            "run Matlock One and the features you use,",
            "keep accounts and data secure and stop abuse,",
            "take payment for your plan,",
            "send you the emails the service needs, such as password resets and billing notices,",
            "help you when you ask for support, and",
            "meet our legal obligations.",
          ]}
        />
        <p>
          We don’t sell your information, use it for advertising, or use it to train AI models.
        </p>
      </LegalSection>

      <LegalSection id="sharing" title="6. Where it goes">
        <p>These companies run parts of Matlock One for us:</p>
        <LegalList
          items={[
            <>
              <strong>Vercel</strong> hosts the website and the app (United States).
            </>,
            <>
              <strong>Supabase</strong> stores the database and your files and photos (United
              States).
            </>,
            <>
              <strong>PayPal</strong> takes payment for Matlock One plans.
            </>,
            <>
              <strong>Hostinger</strong> delivers the emails Matlock One sends on its own behalf,
              such as password resets.
            </>,
            <>
              <strong>GitHub</strong> hosts the Windows app’s downloads and updates; the app
              checks there for new versions.
            </>,
            <>
              <strong>Push services</strong> (Google, Apple, Mozilla and Microsoft, depending on
              the browser) carry notifications to the phones and browsers that turned them on — a
              short line such as a job’s title or the start of a team message. It is encrypted on
              the way, so the push service cannot read it.
            </>,
          ]}
        />
        <p>When you connect a service of your own, information goes to it to do the job you set up:</p>
        <LegalList
          items={[
            <>
              <strong>Your email account</strong> sends the estimates, invoices and messages you
              send your customers.
            </>,
            <>
              <strong>Your payment processor</strong> (PayPal, Stripe, Square or another) receives
              an invoice’s number, title and amount, your business name, and your customer’s name
              and email, so it can make a payment link.
            </>,
            <>
              <strong>QuickBooks Online</strong> (Intuit), if you connect it, receives each of your
              customers’ names, company, email, phone numbers, website and addresses; your
              invoices, with their lines, tax and dates; the payments you receive; and the expenses
              you record, with who they were paid to — so your books match. What was already sent
              stays in QuickBooks if you disconnect it.
            </>,
            <>
              <strong>Calendar apps</strong> (Google, Outlook, Apple) receive a team member’s
              schedule when that person subscribes to their calendar feed: each visit’s title,
              customer, address, crew and notes, but no amounts. Visits already copied into a
              calendar app stay there even after the feed is turned off.
            </>,
          ]}
        />
        <p>
          We’ll also share information if the law requires it. If {LEGAL_NAME} is ever sold or
          merged, your information would pass to the new owner under this policy’s promises.
        </p>
      </LegalSection>

      <LegalSection id="share-links" title="7. Documents you share">
        <p>
          Estimates and invoices you send include a private link, so your customer can view or pay
          without an account. Anyone who has the link can open that document. Each link is long
          and random, so it can’t be guessed.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="8. How long we keep it">
        <LegalList
          items={[
            "While your account exists, we keep your data.",
            "When a plan ends, nothing is deleted; the workspace locks, so you can come back to it exactly as you left it.",
            <>
              To have your business’s data deleted, email{" "}
              <a href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a> from the account owner’s email
              address. We delete it within 30 days of confirming the request. Copies in backups
              are overwritten on our providers’ rolling schedule.
            </>,
            "Billing records may be kept for as long as tax law requires.",
            "The counters used to stop sign-in guessing clear themselves within hours.",
          ]}
        />
      </LegalSection>

      <LegalSection id="security" title="9. Keeping it safe">
        <p>
          Everything travels over an encrypted connection. Passwords are stored only in scrambled
          form, the keys to accounts you connect are encrypted, each person sees only what their
          role allows, and card details never reach our servers. No system is perfect; if a
          breach ever affects your information, we’ll tell you without undue delay.
        </p>
      </LegalSection>

      <LegalSection id="choices" title="10. Your choices">
        <LegalList
          items={[
            "You can see and correct your information in Matlock One at any time.",
            "Reports can be downloaded as spreadsheets. For a complete copy of your business’s data, email us.",
            "You can ask us to delete your data, as described above.",
            "Team members should ask their business’s owner first, since it’s the business’s account.",
          ]}
        />
        <p>
          We answer requests within 30 days. Some US states, such as California, give their
          residents further rights over personal information, and we honor them. We don’t sell
          personal information or share it for cross-site advertising.
        </p>
      </LegalSection>

      <LegalSection id="desktop" title="11. The Windows app">
        <p>
          Online, the Windows app opens the same account as the website, and everything above
          applies. If a business is kept entirely on one computer instead, its data stays on that
          computer and never reaches us; the app still checks GitHub for updates.
        </p>
      </LegalSection>

      <LegalSection id="children" title="12. Children">
        <p>
          Matlock One is for businesses and isn’t meant for anyone under 18. We don’t knowingly
          collect information from children.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="13. Changes to this policy">
        <p>
          The date at the top shows the latest version. For a change that matters, we’ll email the
          account owner or show a notice in Matlock One before it takes effect. See also our{" "}
          <Link href="/terms">Terms of Service</Link>.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="14. Contact">
        <p>
          {LEGAL_NAME}, {LEGAL_CITY}. <a href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a>
        </p>
      </LegalSection>
    </LegalPage>
  );
}

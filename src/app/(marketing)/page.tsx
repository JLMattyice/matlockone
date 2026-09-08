import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check, Download } from "lucide-react";

import {
  HeroDashboard,
  ProductShowcase,
} from "@/components/marketing/product-ui";
import { SubscribeButton } from "@/components/marketing/subscribe-button";
import { buttonClasses } from "@/components/ui/button";
import {
  ANNUAL_DISCOUNT_BP,
  formatPrice,
  planList,
} from "@/lib/checkout/plans";
import { canSellOnline } from "@/lib/checkout/providers";
// The page's "up to N people" claim is the application's own constant, so the
// two can never drift into a promise the software does not keep.
import { DEMO_SEATS } from "@/lib/license/status";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: { absolute: "Matlock One — your business, all in one place" },
  description:
    "Customers, jobs, scheduling, quoting, invoicing and payments in one workspace. Built by Matlock Software Development.",
};

function Section({
  id,
  children,
  className,
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={cn("mx-auto w-full max-w-6xl px-4 lg:px-8", className)}
    >
      {children}
    </section>
  );
}

/* ---------------------------------------------------------------- 01 hero --- */

function Hero() {
  return (
    <div className="relative overflow-hidden">
      {/*
        The studio's forest green, used as light rather than as paint. It sits
        behind the product and falls off before it reaches the type, so the
        headline keeps full contrast against the near-black ground.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-40 mx-auto h-[42rem] max-w-4xl rounded-[50%] opacity-70 blur-[120px]"
        style={{ background: "var(--forest)" }}
      />

      <Section className="relative pt-20 pb-0 lg:pt-28">
        <h1 className="display max-w-3xl text-5xl text-ink sm:text-6xl lg:text-7xl">
          Your business.
          <br />
          All in one place.
        </h1>

        <p className="mt-7 max-w-xl text-lg text-pretty text-ink-muted">
          Matlock One brings customers, jobs, scheduling, quoting, invoicing and
          payments together in one workspace — so the same job never gets typed
          in twice.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-3">
          <a href="#download" className={buttonClasses("primary", "lg")}>
            Download free
            <ArrowRight className="h-4 w-4" strokeWidth={2} aria-hidden />
          </a>
          <a href="#platform" className={buttonClasses("outline", "lg")}>
            Explore Matlock One
          </a>
        </div>

        <p className="mt-4 text-sm text-ink-subtle">
          Runs free for up to {DEMO_SEATS} people, with no time limit and no
          card. A licence key lifts the limit when you need it.
        </p>

        {/* Cropped by the fold on purpose: it reads as continuing, not ending. */}
        <div className="mt-16 lg:mt-20">
          <HeroDashboard />
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------- 02 problem --- */

const SCATTERED = [
  "A CRM nobody updates",
  "A shared calendar",
  "An accounting app",
  "A task board",
  "A folder of job photos",
  "Three spreadsheets",
];

function Problem() {
  return (
    <Section id="product" className="scroll-mt-24 pt-28 lg:pt-36">
      <h2 className="display max-w-2xl text-3xl text-ink sm:text-4xl lg:text-5xl">
        Running a business should not take six different apps
      </h2>
      <p className="mt-5 max-w-xl text-ink-muted">
        Every one of them holds a piece of the same customer. None of them talk.
        The quote lives in one, the schedule in another, and the invoice gets
        rebuilt by hand from both.
      </p>

      <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SCATTERED.map((tool) => (
          <li
            key={tool}
            className="rounded-lg border border-dashed border-line-strong px-4 py-5 text-sm text-ink-subtle"
          >
            {tool}
          </li>
        ))}
      </ul>

      <div className="mt-10 flex items-center gap-4">
        <span aria-hidden className="h-px flex-1 bg-line" />
        <p className="text-sm tracking-[0.18em] text-gold uppercase">
          Bring it together
        </p>
        <span aria-hidden className="h-px flex-1 bg-line" />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------ 03 platform --- */

function Platform() {
  return (
    <Section id="platform" className="scroll-mt-24 pt-20">
      <h2 className="display max-w-2xl text-3xl text-ink sm:text-4xl lg:text-5xl">
        Everything works together
      </h2>
      <p className="mt-5 max-w-xl text-ink-muted">
        Ten modules and the dashboard that reads them, not ten products bolted
        together. Pick any one to see the actual screen.
      </p>

      <div className="mt-12">
        <ProductShowcase />
      </div>
    </Section>
  );
}

/* --------------------------------------------------------------- 04 real --- */

const REAL = [
  {
    title: "265 tests, the money paths checked by mutation",
    body: "Aimed where a bug costs money: cent arithmetic, discount apportionment, invoice balances against a real database, payment reconciliation. The suite was proved by breaking things on purpose.",
  },
  {
    title: "Money is never a floating-point number",
    body: "Every amount is whole cents and every tax rate is basis points. One function computes each total, server-side, from the submitted lines — a tampered payload cannot set its own price.",
  },
  {
    title: "Your data can stay on your machine",
    body: "Matlock One also ships as a Windows installer. The database is a file on that PC and the office machine serves the crew over your own network.",
  },
];

function Real() {
  return (
    <Section className="pt-28 lg:pt-36">
      <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:gap-20">
        <div>
          <h2 className="display text-3xl text-ink sm:text-4xl lg:text-5xl">
            This is real software, not a landing page
          </h2>
          <p className="mt-5 text-ink-muted">
            Everything above is the running application. You can sign in to it
            right now with a demo account and a year of seeded work — quote
            something, schedule it, invoice it, take a payment.
          </p>
          <p className="mt-4 text-ink-muted">
            Sign in as the technician account to watch the permissions work:
            the financial tiles disappear, most of the navigation goes with
            them, and the job list narrows to that person&rsquo;s own work.
          </p>

          <div className="mt-8 rounded-xl border border-line bg-surface-2 p-5">
            <p className="text-sm font-medium text-ink">
              Try it on the demo workspace
            </p>
            <p className="mt-2 text-sm text-ink-muted">
              A shared workspace with a year of seeded work in it. Everyone who
              visits signs into the same one, so treat anything you type there
              as public — and never put a real customer in it.
            </p>

            <Link
              href="/login"
              className={buttonClasses("outline", "md", "mt-5")}
            >
              Open the demo
            </Link>

            {/*
              Behind a click rather than on the page. Working sign-ins printed
              in the open get scraped and indexed; a visitor who actually wants
              them is one click away, and a crawler is not.
            */}
            <details className="group mt-5 border-t border-line pt-4">
              <summary className="cursor-pointer list-none text-sm text-ink-muted transition-colors hover:text-ink">
                Show the sign-ins
              </summary>
              <ul className="tabular mt-3 space-y-1.5 text-sm text-ink-muted">
                <li>owner@demo.test</li>
                <li>manager@demo.test</li>
                <li>tech2@demo.test</li>
              </ul>
              <p className="mt-3 text-sm text-ink-subtle">
                Password <span className="tabular text-gold">demo1234</span>
              </p>
            </details>
          </div>
        </div>

        <ul className="space-y-4 lg:pt-4">
          {REAL.map((item) => (
            <li
              key={item.title}
              className="border-l border-line pl-5 lg:pl-6"
            >
              <p className="text-sm font-medium text-ink">{item.title}</p>
              <p className="mt-2 text-sm text-ink-muted">{item.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

/* --------------------------------------------------------- 05 industries --- */

const INDUSTRIES = [
  { trade: "Construction & trades", job: "Jobs", client: "Customers" },
  { trade: "Consulting", job: "Engagements", client: "Clients" },
  { trade: "Professional services", job: "Matters", client: "Clients" },
  { trade: "Field services", job: "Work orders", client: "Sites" },
  { trade: "Agencies", job: "Projects", client: "Accounts" },
  { trade: "Maintenance & facilities", job: "Call-outs", client: "Properties" },
];

function Industries() {
  return (
    <Section id="industries" className="scroll-mt-24 pt-28 lg:pt-36">
      <h2 className="display max-w-2xl text-3xl text-ink sm:text-4xl lg:text-5xl">
        One platform. Your words for it.
      </h2>
      <p className="mt-5 max-w-xl text-ink-muted">
        The record names are yours to set. Change them once in settings and the
        whole workspace speaks your trade&rsquo;s language — no rebuild, no
        custom version.
      </p>

      <div className="mt-12 overflow-x-auto">
        <table className="w-full min-w-[30rem] text-left text-sm">
          <thead>
            <tr className="border-b border-line">
              <th
                scope="col"
                className="py-3 pr-4 text-xs tracking-[0.16em] text-ink-subtle uppercase"
              >
                Business
              </th>
              <th
                scope="col"
                className="py-3 pr-4 text-xs tracking-[0.16em] text-ink-subtle uppercase"
              >
                A job is called
              </th>
              <th
                scope="col"
                className="py-3 text-xs tracking-[0.16em] text-ink-subtle uppercase"
              >
                A customer is called
              </th>
            </tr>
          </thead>
          <tbody>
            {INDUSTRIES.map((row) => (
              <tr key={row.trade} className="border-b border-line last:border-0">
                <td className="py-4 pr-4 text-ink">{row.trade}</td>
                <td className="py-4 pr-4 text-gold">{row.job}</td>
                <td className="py-4 text-ink-muted">{row.client}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------ 06 pricing --- */

/**
 * Every plan carries the whole product, including the install you own. The
 * tiers differ by how many people are in the workspace — which is the only
 * difference the software could honestly enforce, and it keeps the ownership
 * argument out of the upsell.
 */
const INCLUDED = [
  "The Windows install — run it on your own machine",
  "Customers, leads, jobs and scheduling",
  "Estimates, invoices and payments",
  "Documents, job photos and reports",
  "Roles and permissions",
  "Your own mailbox and payment accounts",
];

// Plans come from the checkout catalog, so the price on this page is the price
// that gets charged and the seats advertised are the seats the licence carries.
// A number retyped into marketing copy is a number that eventually lies.
const PLANS = planList();

function Pricing() {
  // Whether this deployment can actually take money right now. Without it the
  // cards point at the free download instead of a button that would fail.
  const sellable = canSellOnline();

  return (
    <Section id="pricing" className="scroll-mt-24 pt-28 lg:pt-36">
      <h2 className="display max-w-2xl text-3xl text-ink sm:text-4xl lg:text-5xl">
        Simple pricing
      </h2>
      <p className="mt-5 max-w-xl text-ink-muted">
        Every plan includes the whole workspace. What changes is how many people
        are in it with you.
      </p>

      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        {PLANS.map((plan) => (
          <div
            key={plan.name}
            className={cn(
              "relative flex flex-col rounded-xl border p-6",
              plan.featured
                ? "border-gold/45 bg-surface-2"
                : "border-line bg-surface-2/60",
            )}
          >
            {plan.featured ? (
              <span className="absolute -top-2.5 left-6 rounded-full border border-gold/45 bg-surface px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-gold">
                Most popular
              </span>
            ) : null}

            <p className="text-sm font-medium text-ink">{plan.name}</p>
            <p className="mt-4 flex items-baseline gap-1.5">
              <span className="display tabular text-4xl text-ink">
                {formatPrice(plan.monthlyCents)}
              </span>
              <span className="text-sm text-ink-subtle">/month</span>
            </p>

            <p
              className={cn(
                "mt-4 text-sm font-medium",
                plan.featured ? "text-gold" : "text-brand",
              )}
            >
              {plan.seatLabel}
            </p>
            <p className="mt-2 flex-1 text-sm text-ink-muted">{plan.tagline}</p>

            {plan.extras.length > 0 ? (
              <ul className="mt-5 space-y-2.5">
                {plan.extras.map((extra) => (
                  <li key={extra} className="flex gap-2.5 text-sm text-ink-muted">
                    <Check
                      className={cn(
                        "mt-0.5 h-4 w-4 shrink-0",
                        plan.featured ? "text-gold" : "text-brand",
                      )}
                      strokeWidth={2}
                      aria-hidden
                    />
                    {extra}
                  </li>
                ))}
              </ul>
            ) : null}

            {sellable ? (
              <SubscribeButton
                plan={plan.id}
                featured={plan.featured}
                label={`Subscribe to ${plan.name}`}
              />
            ) : (
              <a
                href="#download"
                className={buttonClasses(
                  plan.featured ? "primary" : "outline",
                  "md",
                  "mt-8 justify-center",
                )}
              >
                Start with the free version
              </a>
            )}
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-xl border border-line bg-surface-2 p-6">
        <p className="text-sm font-medium text-ink">
          In every plan, including Starter
        </p>
        <ul className="mt-4 grid gap-x-8 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {INCLUDED.map((item) => (
            <li key={item} className="flex gap-2.5 text-sm text-ink-muted">
              <Check
                className="mt-0.5 h-4 w-4 shrink-0 text-brand"
                strokeWidth={2}
                aria-hidden
              />
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-5 text-sm text-ink-muted">
          The install is not an upgrade. Owning your data is the point of the
          product, so it is in the cheapest plan too.
        </p>
      </div>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium text-ink">How buying works</h3>
          <ol className="mt-3 space-y-2 text-sm text-ink-muted">
            <li>
              1. Download and use it free for up to {DEMO_SEATS} people. No
              time limit, no card, and it is the whole product, not a cut-down
              one.
            </li>
            <li>
              2. When you need more people, subscribe and a licence key arrives
              by email.
            </li>
            <li>
              3. Paste it into Settings → Licence. Everything you already
              entered stays exactly where it is.
            </li>
          </ol>
        </div>

        <div>
          <h3 className="text-sm font-medium text-ink">
            What the licence does
          </h3>
          <p className="mt-3 text-sm text-ink-muted">
            It is checked on your own machine, against a key built into the
            software — never by calling us. Matlock One keeps working on a job
            site with no signal, and nothing about your business is transmitted
            to verify it.
          </p>
          <p className="mt-3 text-sm text-ink-muted">
            If a licence lapses, the workspace returns to the free limits.
            Nobody is deactivated and no record is deleted.
          </p>
        </div>
      </div>

      <p className="mt-8 text-sm text-ink-muted">
        <span className="text-gold">
          Save {ANNUAL_DISCOUNT_BP / 100}% with annual billing.
        </span>
      </p>

      {sellable ? null : (
        <div className="mt-3 max-w-xl">
          <Placeholder>
            PayPal is not configured on this deployment, so these plans cannot
            be bought from the site yet. Set PAYPAL_CLIENT_ID,
            PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID and a billing plan id per
            plan, and these become real subscribe buttons.
          </Placeholder>
        </div>
      )}
    </Section>
  );
}

/* ----------------------------------------------------------- 07 download --- */

/**
 * The two builds, and the honest state of each.
 *
 * A link that does not exist yet renders as a marked blank rather than a dead
 * button: a download that 404s costs more trust than one that is openly not
 * ready. Publishing either is a one-line change here.
 */
const DOWNLOADS = [
  {
    platform: "Windows",
    detail: "Windows 10 and 11 · 64-bit",
    url: null as string | null,
    missing:
      "The installer builds today with npm run desktop:pack — it just is not hosted anywhere yet. Set this entry's url once the .exe has a home.",
  },
  {
    platform: "macOS",
    detail: "Apple Silicon · macOS 12 and later",
    url: null as string | null,
    missing:
      "No macOS build exists yet. It needs a signed, notarized build produced on a Mac; the config and entitlements are ready for it.",
  },
];

/** An unfilled blank, marked as one. Never a guess dressed up as content. */
function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-xs text-ink-subtle">
      {children}
    </p>
  );
}

function DownloadSection() {
  return (
    <Section id="download" className="scroll-mt-24 pt-28 lg:pt-36">
      <div className="grid gap-10 lg:grid-cols-[1fr_1fr] lg:gap-20">
        <div>
          <h2 className="display text-3xl text-ink sm:text-4xl lg:text-5xl">
            Run it on your own machine
          </h2>
          <p className="mt-5 text-ink-muted">
            The desktop build is the same application, served from your own
            computer instead of ours. The database is a file on that machine,
            and the office PC hosts the crew over your own network — a phone in
            the driveway sees today&rsquo;s work without any of it leaving the
            building.
          </p>
          <p className="mt-4 text-ink-muted">
            It installs without a terminal and opens to a sign-in screen. On
            first run it creates its own database; nothing else to configure.
          </p>
          <p className="mt-4 text-ink-muted">
            No account and no card to download it. It runs free for up to{" "}
            {DEMO_SEATS} active people, for as long as you like — every module,
            no expiry, no watermark. Add a licence key when your crew outgrows
            that.
          </p>
          <p className="mt-4 text-sm text-gold">
            Included in every plan, Starter upward.
          </p>
        </div>

        <div className="space-y-3">
          {DOWNLOADS.map((build) => (
            <div
              key={build.platform}
              className="rounded-xl border border-line bg-surface-2 p-5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-sm font-medium text-ink">
                  {build.platform}
                </p>
                <p className="text-xs text-ink-subtle">{build.detail}</p>
              </div>

              <div className="mt-4">
                {build.url ? (
                  <a
                    href={build.url}
                    className={buttonClasses("primary", "md")}
                  >
                    <Download
                      className="h-4 w-4"
                      strokeWidth={2}
                      aria-hidden
                    />
                    Download for {build.platform}
                  </a>
                ) : (
                  <Placeholder>{build.missing}</Placeholder>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- 08 cta --- */

function FinalCta() {
  return (
    <div className="relative mt-28 overflow-hidden border-t border-line lg:mt-36">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -bottom-64 mx-auto h-[34rem] max-w-3xl rounded-[50%] opacity-60 blur-[120px]"
        style={{ background: "var(--forest)" }}
      />
      <Section className="relative py-28 text-center lg:py-36">
        <h2 className="display mx-auto max-w-3xl text-4xl text-balance text-ink sm:text-5xl lg:text-6xl">
          Everything your business needs. Nothing in the way.
        </h2>

        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <a href="#download" className={buttonClasses("primary", "lg")}>
            Download Matlock One
            <ArrowRight className="h-4 w-4" strokeWidth={2} aria-hidden />
          </a>
          <Link href="/login" className={buttonClasses("outline", "lg")}>
            Try the demo first
          </Link>
        </div>

        <p className="mt-8 text-sm text-ink-subtle">
          Built by Matlock Software Development.
        </p>
      </Section>
    </div>
  );
}

export default function MatlockOnePage() {
  return (
    <>
      <Hero />
      <Problem />
      <Platform />
      <Real />
      <Industries />
      <Pricing />
      <DownloadSection />
      <FinalCta />
    </>
  );
}

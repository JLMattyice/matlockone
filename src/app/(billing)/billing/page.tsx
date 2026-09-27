import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { format } from "date-fns";

import { cancelPlan, choosePlan } from "./actions";
import { LicenseForm } from "@/app/(app)/settings/license/license-form";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { SubmitButton } from "@/components/ui/submit";
import { requireContext } from "@/lib/auth";
import { entitlement, GRACE_DAYS } from "@/lib/billing/entitlement";
import { CANCELLABLE, restartDate } from "@/lib/billing/subscription";
import {
  ANNUAL_DISCOUNT_BP,
  annualCents,
  formatPrice,
  isPlan,
  planList,
  PLANS,
  type Plan,
} from "@/lib/checkout/plans";
import { manageSubscriptionUrl, paypalConfig } from "@/lib/checkout/paypal";
import { dataStaysOnThisMachine } from "@/lib/config";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Billing" };

/**
 * The billing screen: the only page a business that has not paid can open.
 *
 * It is also where a paying business sees and changes its plan, so it has to
 * read right in every state — about to start, lapsed, paying, cancelled but
 * still open, exempt, and a desktop install that pays by licence key instead.
 */

/**
 * Fixed text for each error the checkout can come back with. The address
 * carries only the code, so nobody can craft a link that puts words of their
 * own in front of an owner here.
 */
const ERRORS: Record<string, string> = {
  plan: "Choose one of the plans shown.",
  paypal: "PayPal didn’t accept that just now. Nothing was charged — try again in a moment.",
  setup: "Payments aren’t set up on this site yet.",
  cancel:
    "PayPal didn’t cancel it just now, so nothing has changed. Try again in a moment, or cancel it in PayPal.",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const longDate = (date: Date) => format(date, "MMMM d, yyyy");

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{
    welcome?: string;
    cancelled?: string;
    error?: string;
    seats?: string;
    plan_cancelled?: string;
  }>;
}) {
  const { user, org } = await requireContext({ unpaid: "allow" });

  // The demo is never billed, and cannot be.
  if (org.isDemo) redirect("/dashboard");

  const params = await searchParams;
  const access = entitlement(org);
  const canPay = can(user, "settings:write");
  const local = dataStaysOnThisMachine();
  const config = local ? null : paypalConfig();

  const owner = canPay
    ? null
    : await prisma.user.findFirst({
        where: { organizationId: org.id, role: "OWNER", isActive: true },
        select: { name: true },
      });

  // The date comes from the database, never the address, like every other
  // word here.
  const notice = params.error
    ? (ERRORS[params.error] ?? ERRORS.paypal)
    : params.cancelled
      ? "You left PayPal before finishing, so nothing was charged."
      : params.plan_cancelled && org.paidThrough && access.ok
        ? `Your plan is cancelled. No more payments will be taken, and ${org.name} stays open until ${longDate(org.paidThrough)}.`
        : params.seats === "full" && access.ok
          ? "Your plan is full. Move to a larger one to add more people."
          : null;

  // A cancelled plan with paid-for time left: a new one starts when that
  // time runs out. One already approved to start then is changed by
  // cancelling it first, not by approving a second beside it.
  const restartsOn = access.ok ? restartDate(org) : null;
  const waitingToStart = org.subscriptionStatus === "APPROVED";

  return (
    <div className="space-y-6 py-4">
      <Heading
        title={
          access.ok
            ? "Billing"
            : params.welcome
              ? "Choose a plan to start"
              : access.reason === "lapsed"
                ? `${org.name}’s plan has ended`
                : "Choose a plan to start using Matlock One"
        }
        lead={
          access.ok
            ? null
            : access.reason === "lapsed"
              ? "Choose a plan to open it again. Nothing has been deleted — everything is where you left it."
              : "Pick the plan that fits, approve it with PayPal, and you’re in. Every plan includes every part of Matlock One."
        }
      />

      {notice ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink" role="status">
          {notice}
        </p>
      ) : null}

      {access.ok && access.via === "subscription" ? (
        <CurrentPlan
          plan={access.plan}
          interval={org.subscriptionInterval}
          status={org.subscriptionStatus}
          paidThrough={org.paidThrough}
          manageUrl={manageSubscriptionUrl(config)}
          canCancel={canPay && !!config && CANCELLABLE.has(org.subscriptionStatus ?? "")}
        />
      ) : null}

      {access.ok && access.via !== "subscription" ? (
        <Card>
          <CardBody className="space-y-3 p-6">
            <p className="text-sm text-ink">
              {access.via === "exempt"
                ? `${org.name} runs without a subscription.`
                : `${org.name} runs on a licence key.`}
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/dashboard" className={buttonClasses("outline", "md")}>
                Back to Matlock One
              </Link>
              {access.via === "licence" && local ? (
                <Link href="/settings/license" className={buttonClasses("outline", "md")}>
                  Licence
                </Link>
              ) : null}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {!access.ok && local ? (
        // A desktop install pays by licence key: the hosted app's PayPal
        // checkout cannot reach a computer on an office network.
        <div className="space-y-4">
          <LicenseForm licensed={false} />
          <p className="text-sm text-ink-muted">
            Once the key is accepted,{" "}
            <Link href="/dashboard" className="font-medium text-brand hover:underline">
              open Matlock One
            </Link>
            .
          </p>
        </div>
      ) : null}

      {!access.ok && !local && !canPay ? (
        <Card>
          <CardBody className="p-6 text-sm text-ink">
            {org.name} doesn’t have an active plan.{" "}
            {owner ? `Ask ${owner.name} to choose one` : "Ask the owner to choose one"}, then
            sign in again.
          </CardBody>
        </Card>
      ) : null}

      {!local &&
      canPay &&
      (!access.ok || (access.via === "subscription" && !waitingToStart)) ? (
        config ? (
          <section className="space-y-3">
            {access.ok ? (
              <div className="space-y-1">
                <h2 className="text-sm font-medium text-ink">
                  {restartsOn ? `Keep going after ${longDate(restartsOn)}` : "Change plan"}
                </h2>
                {restartsOn ? (
                  <p className="text-sm text-ink-muted">
                    Choose a plan and it starts on {longDate(restartsOn)}, when the time
                    you’ve paid for runs out, so nothing is charged twice.
                  </p>
                ) : null}
              </div>
            ) : null}
            <PlanCards
              // Only a plan that is renewing is the one to stay on. After a
              // cancellation every button is a way back, the same one included.
              current={
                access.ok && org.subscriptionStatus === "ACTIVE" && isPlan(org.subscriptionPlan)
                  ? org.subscriptionPlan
                  : null
              }
              currentInterval={access.ok ? org.subscriptionInterval : null}
            />
          </section>
        ) : (
          <Card>
            <CardBody className="p-6 text-sm text-ink">{ERRORS.setup}</CardBody>
          </Card>
        )
      ) : null}
    </div>
  );
}

function Heading({ title, lead }: { title: string; lead: string | null }) {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      {lead ? <p className="max-w-2xl text-sm text-ink-muted">{lead}</p> : null}
    </div>
  );
}

function CurrentPlan({
  plan,
  interval,
  status,
  paidThrough,
  manageUrl,
  canCancel,
}: {
  plan: Plan["id"] | null;
  interval: string | null;
  status: string | null;
  paidThrough: Date | null;
  manageUrl: string;
  canCancel: boolean;
}) {
  const name = plan ? PLANS[plan].name : "Your";
  const billed = interval === "annual" ? "billed yearly" : "billed monthly";

  // Said in terms of what happens next, because that is what somebody opening
  // billing wants to know.
  const standing =
    !paidThrough
      ? null
      : status === "CANCELLED"
        ? `Cancelled. ${name === "Your" ? "It" : "Your plan"} stays open until ${longDate(paidThrough)}, then closes.`
        : status === "SUSPENDED"
          ? `PayPal couldn’t take the last payment and will try again. Update your payment in PayPal before ${longDate(new Date(paidThrough.getTime() + GRACE_DAYS * DAY_MS))} to keep it open.`
          : status === "APPROVED"
            ? `Starts on ${longDate(paidThrough)}, when the time already paid for runs out. PayPal takes the first payment then. To choose a different plan, cancel this one first.`
            : `Paid through ${longDate(paidThrough)}. Renews automatically.`;

  return (
    <Card>
      <CardBody className="space-y-4 p-6">
        <div className="space-y-1">
          <p className="text-base font-medium text-ink">
            {name} plan <span className="font-normal text-ink-muted">· {billed}</span>
          </p>
          {standing ? <p className="text-sm text-ink-muted">{standing}</p> : null}
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/dashboard" className={buttonClasses("primary", "md")}>
            Back to Matlock One
          </Link>
          <a href={manageUrl} className={buttonClasses("outline", "md")} target="_blank" rel="noreferrer">
            Manage in PayPal
          </a>
        </div>

        {canCancel && paidThrough ? (
          // Folded away, so it is found by looking for it rather than
          // passed on the way to something else; and the button inside
          // takes a second click, like every other thing that ends something.
          <details className="border-t border-line pt-4">
            <summary className="cursor-pointer text-sm text-ink-muted hover:text-ink">
              Cancel subscription
            </summary>
            <div className="mt-3 space-y-3">
              <p className="max-w-xl text-sm text-ink-muted">
                No more payments will be taken. Matlock One stays open until{" "}
                {longDate(paidThrough)}, then closes. Nothing is deleted, and you can choose a
                plan again whenever you like.
              </p>
              <form action={cancelPlan}>
                <ConfirmButton
                  variant="outline"
                  confirmLabel="Click again to cancel"
                  pendingLabel="Cancelling…"
                >
                  Cancel my plan
                </ConfirmButton>
              </form>
            </div>
          </details>
        ) : null}
      </CardBody>
    </Card>
  );
}

function PlanCards({
  current,
  currentInterval,
}: {
  current: Plan["id"] | null;
  currentInterval: string | null;
}) {
  const saving = Math.round(ANNUAL_DISCOUNT_BP / 100);

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {planList().map((plan) => (
        <Card key={plan.id} className={plan.featured ? "border-brand/40" : undefined}>
          <CardBody className="flex h-full flex-col gap-4 p-5">
            <div className="space-y-1">
              <p className="text-base font-semibold text-ink">{plan.name}</p>
              <p className="text-sm text-ink-muted">{plan.tagline}</p>
              <p className="text-xs text-ink-subtle">{plan.seatLabel}</p>
            </div>

            <div className="space-y-0.5">
              <p className="text-2xl font-semibold text-ink tabular">
                {formatPrice(plan.monthlyCents)}
                <span className="text-sm font-normal text-ink-muted"> / month</span>
              </p>
              <p className="text-xs text-ink-subtle">
                or {formatPrice(annualCents(plan))} a year — save {saving}%
              </p>
            </div>

            {plan.extras.length ? (
              <ul className="space-y-1 text-sm text-ink-muted">
                {plan.extras.map((extra) => (
                  <li key={extra}>{extra}</li>
                ))}
              </ul>
            ) : null}

            <div className="mt-auto flex flex-wrap gap-2">
              {(["monthly", "annual"] as const).map((interval) => {
                const isCurrent = current === plan.id && currentInterval === interval;
                return (
                  <form key={interval} action={choosePlan}>
                    <input type="hidden" name="plan" value={plan.id} />
                    <input type="hidden" name="interval" value={interval} />
                    {isCurrent ? (
                      <span className={buttonClasses("outline", "md")} aria-current="true">
                        Current plan
                      </span>
                    ) : (
                      <SubmitButton
                        variant={interval === "monthly" && plan.featured ? "primary" : "outline"}
                        size="md"
                        pendingLabel="Opening PayPal…"
                      >
                        {interval === "monthly" ? "Monthly" : "Yearly"}
                      </SubmitButton>
                    )}
                  </form>
                );
              })}
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

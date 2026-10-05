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
import { launchMonthCents } from "@/lib/billing/launch-offer";
import { CANCELLABLE, launchPriceFor, restartDate } from "@/lib/billing/subscription";
import { storageUsage, type StorageUsage } from "@/lib/quotas";
import { formatBytes } from "@/lib/storage-limits";
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

  // The first month at the launch offer's price, for each plan this business
  // would get it on — asked the same way the checkout asks.
  const firstMonth = Object.fromEntries(
    planList()
      .filter((plan) => launchPriceFor(org, config, plan.id, "monthly"))
      .map((plan) => [plan.id, launchMonthCents(plan)]),
  ) as Partial<Record<Plan["id"], number>>;
  const launchOffer = Object.keys(firstMonth).length > 0;

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
          storage={await storageUsage(org)}
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

      {access.ok && access.via === "licence" && !local && canPay ? (
        // The hosted app has no licence settings page, so a key is renewed
        // here — which is also where the expiry banner's link lands.
        <LicenseForm licensed />
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
            {owner ? `Ask ${owner.name} to choose one` : "Ask the owner to choose one"} or enter
            a licence key, then sign in again.
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
            {launchOffer ? (
              <p className="rounded-lg border border-brand/40 bg-surface px-4 py-3 text-sm text-ink">
                <span className="font-medium">Launch week:</span> your first month is half price
                on any monthly plan.
              </p>
            ) : null}
            <PlanCards
              firstMonth={firstMonth}
              // Only a plan that is renewing is the one to stay on. After a
              // cancellation every button is a way back, the same one included.
              current={
                access.ok && org.subscriptionStatus === "ACTIVE" && isPlan(org.subscriptionPlan)
                  ? org.subscriptionPlan
                  : null
              }
              currentInterval={access.ok ? org.subscriptionInterval : null}
            />
            {/* What a plan commits them to, beside the buttons that commit
                them to it. */}
            <p className="text-xs leading-relaxed text-ink-muted">
              {launchOffer
                ? "The launch-week price is for the first month only; after that a monthly plan renews at its regular price. "
                : null}
              Plans renew automatically until you cancel. Cancel any time here and keep
              everything until the end of what you’ve paid for; unused time isn’t refunded.
              Choosing a plan means you agree to the{" "}
              <Link href="/terms" className="font-medium text-ink hover:underline">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/refunds" className="font-medium text-ink hover:underline">
                Refund Policy
              </Link>
              .
            </p>
          </section>
        ) : (
          <Card>
            <CardBody className="p-6 text-sm text-ink">{ERRORS.setup}</CardBody>
          </Card>
        )
      ) : null}

      {!access.ok && !local && canPay ? (
        // A business that already holds a key — one bought before plans
        // were sold here, or issued by hand — opens with it rather than
        // paying twice. Offered even where PayPal is not set up, since a key
        // needs nothing from PayPal.
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-sm font-medium text-ink">Already have a licence key?</h2>
            <p className="text-sm text-ink-muted">Enter it here instead of choosing a plan.</p>
          </div>
          <LicenseForm licensed={false} />
        </section>
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
  storage,
}: {
  plan: Plan["id"] | null;
  interval: string | null;
  status: string | null;
  paidThrough: Date | null;
  manageUrl: string;
  canCancel: boolean;
  storage: StorageUsage;
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

        {storage.allowance !== null ? <StorageMeter used={storage.used} allowance={storage.allowance} /> : null}
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

/**
 * Files used against the plan's allowance. Amber from 90%, so there is warning
 * before an upload is refused.
 */
function StorageMeter({ used, allowance }: { used: number; allowance: number }) {
  const share = Math.min(used / allowance, 1);
  const nearlyFull = share >= 0.9;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-ink">Files and photos</span>
        <span className="tabular text-ink-muted">
          {formatBytes(used)} of {formatBytes(allowance)}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-label="Storage used"
        aria-valuemin={0}
        aria-valuemax={allowance}
        aria-valuenow={Math.min(used, allowance)}
      >
        <div
          className={nearlyFull ? "h-full bg-warning" : "h-full bg-brand"}
          style={{ width: `${Math.max(share * 100, used > 0 ? 1 : 0)}%` }}
        />
      </div>
      {nearlyFull ? (
        <p className="text-xs text-warning">
          {share >= 1
            ? "Full. New files can’t be added until some are deleted or the plan is larger."
            : "Nearly full. Delete files you no longer need, or move to a larger plan."}
        </p>
      ) : null}
    </div>
  );
}

function PlanCards({
  current,
  currentInterval,
  firstMonth,
}: {
  current: Plan["id"] | null;
  currentInterval: string | null;
  /** The launch offer's first month, for each plan this business gets it on. */
  firstMonth: Partial<Record<Plan["id"], number>>;
}) {
  const saving = Math.round(ANNUAL_DISCOUNT_BP / 100);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {planList().map((plan) => (
        <Card key={plan.id} className={plan.featured ? "border-brand/40" : undefined}>
          <CardBody className="flex h-full flex-col gap-4 p-5">
            <div className="space-y-1">
              <p className="text-base font-semibold text-ink">{plan.name}</p>
              <p className="text-sm text-ink-muted">{plan.tagline}</p>
              <p className="text-xs text-ink-subtle">
                {plan.seatLabel} · {plan.storageLabel}
              </p>
            </div>

            <div className="space-y-0.5">
              <p className="text-2xl font-semibold text-ink tabular">
                {formatPrice(plan.monthlyCents)}
                <span className="text-sm font-normal text-ink-muted"> / month</span>
              </p>
              {firstMonth[plan.id] !== undefined ? (
                <p className="text-sm font-medium text-brand">
                  {formatPrice(firstMonth[plan.id]!)} for your first month
                </p>
              ) : null}
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

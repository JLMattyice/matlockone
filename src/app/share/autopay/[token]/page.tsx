import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { AlertTriangle, Check, Clock, Repeat } from "lucide-react";

import { ShareRefused } from "../../refused";
import { autopayInvite, syncAutopay } from "@/lib/autopay";
import { formatMoney } from "@/lib/money";
import { hit, PAY_REDIRECT_PER_INVOICE } from "@/lib/rate-limit";
import { shareAllowed, shareMissed } from "@/lib/share-guard";
import { DEFAULT_BRAND_COLOR, hexToRgbChannels } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Pay automatically",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The customer's auto-pay invite.
 *
 * Says plainly what they are agreeing to — how much, how often, from when —
 * and sends them to PayPal to approve it. PayPal brings them back here, and
 * the page asks PayPal whether it took, so the customer leaves knowing.
 */
export default async function AutopayInvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string; cancelled?: string; problem?: string }>;
}) {
  const { token } = await params;
  const { done, cancelled, problem } = await searchParams;

  const allowed = await shareAllowed();
  if (!allowed.ok) return <ShareRefused retryAfterSeconds={allowed.retryAfterSeconds} />;

  let invite = await autopayInvite(token);
  if (!invite) {
    await shareMissed();
    notFound();
  }

  // Back from PayPal: ask it now, rather than leave the customer reading
  // "not set up" until the morning run. Counted with the button's hits, since
  // this also calls PayPal.
  if (done && !invite.alreadyOn && (await hit(`autopay:${token}`, PAY_REDIRECT_PER_INVOICE)).ok) {
    await syncAutopay({ scheduleId: invite.scheduleId });
    invite = (await autopayInvite(token)) ?? invite;
  }

  const org = invite.organization;
  const brand = hexToRgbChannels(org.primaryColor ?? "") ? org.primaryColor! : DEFAULT_BRAND_COLOR;
  const amount = formatMoney(invite.amountCents, org.currency, org.locale);
  const starting = format(invite.firstPayment, "MMMM d, yyyy");

  const notice = invite.alreadyOn
    ? null
    : done
      ? {
          tone: "wait" as const,
          text: "PayPal is still confirming. There is nothing more you need to do — this page will show it once PayPal has.",
        }
      : cancelled
        ? { tone: "warn" as const, text: "Nothing was set up. You can try again below whenever you like." }
        : problem === "too-many"
          ? { tone: "warn" as const, text: "That was tried a few too many times just now. Please wait a little while and try again." }
          : problem
            ? {
                tone: "warn" as const,
                text: `Setting up auto-pay is not available right now. Please try again shortly, or contact ${org.name}.`,
              }
            : null;

  return (
    <div
      style={{ "--brand": brand } as React.CSSProperties}
      className="min-h-screen bg-surface-2 px-4 py-8 sm:py-12"
    >
      <div className="mx-auto max-w-lg space-y-5">
        <p className="text-sm text-ink-muted">
          From <span className="font-medium text-ink">{org.name}</span>
        </p>

        {notice ? (
          <p
            className={
              notice.tone === "wait"
                ? "flex gap-2 rounded-card border border-line bg-surface px-4 py-3 text-sm text-ink"
                : "flex gap-2 rounded-card border border-warning/30 bg-warning/8 px-4 py-3 text-sm text-ink"
            }
          >
            {notice.tone === "wait" ? (
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={2} aria-hidden />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" strokeWidth={2} aria-hidden />
            )}
            {notice.text}
          </p>
        ) : null}

        <div className="rounded-card border border-line bg-surface p-6 shadow-xs">
          {invite.alreadyOn ? (
            <>
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success/12 text-success">
                <Check className="h-5 w-5" strokeWidth={2.25} aria-hidden />
              </span>
              <h1 className="mt-4 text-xl font-semibold tracking-tight text-ink">
                Auto-pay is set up
              </h1>
              <p className="mt-2 text-sm text-ink-muted">
                Thank you, {invite.clientName}. PayPal will pay {org.name}{" "}
                <span className="font-medium text-ink">{amount}</span> {invite.rhythm} for{" "}
                {invite.what}. You can close this page.
              </p>
              <p className="mt-4 text-xs text-ink-subtle">
                You can cancel any time from your PayPal account, under Payments → Automatic payments.
              </p>
            </>
          ) : (
            <>
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand/12 text-brand">
                <Repeat className="h-5 w-5" strokeWidth={2} aria-hidden />
              </span>
              <h1 className="mt-4 text-xl font-semibold tracking-tight text-ink">
                Pay {org.name} automatically
              </h1>
              <p className="mt-2 text-sm text-ink-muted">
                Hi {invite.clientName}. Instead of paying each invoice by hand, you can have
                PayPal pay {org.name} for you, automatically, each time.
              </p>

              <dl className="mt-5 divide-y divide-line rounded-card border border-line text-sm">
                <Row label="For">{invite.what}</Row>
                <Row label="Amount">
                  <span className="tabular font-semibold text-ink">{amount}</span> {invite.rhythm}
                </Row>
                <Row label="First payment">{starting}</Row>
                {invite.endDate ? (
                  <Row label="Last payment">by {format(invite.endDate, "MMMM d, yyyy")}</Row>
                ) : null}
              </dl>

              <a
                href={`/share/autopay/${token}/start`}
                className="mt-5 flex items-center justify-center rounded-card bg-brand px-5 py-3.5 text-sm font-semibold text-brand-ink shadow-sm transition hover:brightness-110"
              >
                Set up with PayPal
              </a>

              <p className="mt-4 text-xs text-ink-subtle">
                You approve it on PayPal&apos;s own site; {org.name} never sees your card or bank
                details. You can cancel any time from your PayPal account.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right text-ink">{children}</dd>
    </div>
  );
}

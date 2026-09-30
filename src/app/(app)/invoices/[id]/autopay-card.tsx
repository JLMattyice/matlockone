import { format } from "date-fns";
import { AlertTriangle, BadgeCheck } from "lucide-react";

import { CheckAutopay, EmailInvite, OfferAutopay, TurnOffAutopay } from "./autopay-panel";
import { CopyLink } from "../../estimates/[id]/estimate-actions";
import { Card, CardHeader } from "@/components/ui/card";
import type { AutopayStatus } from "@/lib/autopay";
import { publicUrl } from "@/lib/messaging";
import { formatIn } from "@/lib/time-zone";

/**
 * The Auto-pay card, under Repeat on an invoice in a series.
 *
 * Four states, one at a time: off (offer it), invited (the link, and a way to
 * send it), on (what PayPal is collecting), and on hold (PayPal could not
 * collect). Each says in plain words what will and will not happen next,
 * because this is the one place in the app where money moves without anybody
 * pressing a button.
 */
export function AutopayCard({
  invoiceId,
  clientName,
  clientEmail,
  status,
  latestTotalCents,
  money,
  rhythm,
  can,
  zone,
}: {
  invoiceId: string;
  clientName: string;
  clientEmail: string | null;
  status: AutopayStatus;
  /** The latest invoice in the series, which is what auto-pay should be charging. */
  latestTotalCents: number | null;
  money: (cents: number) => string;
  rhythm: string;
  can: { write: boolean; send: boolean; record: boolean };
  /** The viewer's time zone, from viewerTimeZone(). */
  zone: string;
}) {
  const description =
    status.state === "on"
      ? `On — PayPal collects ${money(status.amountCents)} ${rhythm}`
      : status.state === "on-hold"
        ? "On hold — PayPal could not collect a payment"
        : status.state === "invited"
          ? `Offered at ${money(status.amountCents)} ${rhythm} — waiting for ${clientName}`
          : status.state === "off"
            ? `Let ${clientName} pay ${rhythm} without being asked, through PayPal.`
            : status.reason;

  const drifted =
    (status.state === "on" || status.state === "on-hold" || status.state === "invited") &&
    latestTotalCents !== null &&
    latestTotalCents !== status.amountCents;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <BadgeCheck
              className={
                status.state === "on" ? "h-3.5 w-3.5 text-success" : "h-3.5 w-3.5 text-ink-subtle"
              }
              strokeWidth={2}
            />
            Auto-pay
          </span>
        }
        description={description}
      />

      {status.state === "on-hold" ? (
        <p className="flex gap-2 border-b border-line bg-warning/8 px-5 py-3 text-xs text-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={2} aria-hidden />
          PayPal tried several times and could not take a payment. Invoices from here need
          sending and paying the usual way until {clientName} sorts it out at PayPal.
        </p>
      ) : null}

      {drifted ? (
        <p className="flex gap-2 border-b border-line bg-warning/8 px-5 py-3 text-xs text-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={2} aria-hidden />
          PayPal is set to {money("amountCents" in status ? status.amountCents : 0)}, but the latest
          invoice is {money(latestTotalCents ?? 0)}. The difference will show as owing. To change
          what PayPal takes, turn auto-pay off and offer it again.
        </p>
      ) : null}

      <div className="space-y-3 px-5 py-4">
        {status.state === "off" && can.write ? <OfferAutopay invoiceId={invoiceId} /> : null}

        {status.state === "invited" ? (
          <>
            <p className="text-xs text-ink-muted">
              Nothing is charged until {clientName} approves it on PayPal. Send them this link:
            </p>
            <CopyLink url={publicUrl(`/share/autopay/${status.token}`)} />
            {can.send ? <EmailInvite invoiceId={invoiceId} defaultEmail={clientEmail} /> : null}
            {can.write ? <TurnOffAutopay invoiceId={invoiceId} label="Withdraw the offer" /> : null}
          </>
        ) : null}

        {status.state === "on" || status.state === "on-hold" ? (
          <>
            <dl className="space-y-1 text-xs">
              {status.payerEmail ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-muted">PayPal account</dt>
                  <dd className="truncate text-ink">{status.payerEmail}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">First payment</dt>
                <dd className="text-ink">{format(status.startsAt, "MMM d, yyyy")}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Last checked</dt>
                <dd className="text-ink">
                  {status.checkedAt ? formatIn(status.checkedAt, "MMM d, h:mm a", zone) : "Not yet"}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-ink-subtle">
              Each period&apos;s invoice is made as usual and marked paid when PayPal&apos;s
              payment lands. Nothing needs sending.
            </p>
            <div className="flex flex-wrap items-start gap-2">
              {can.record ? <CheckAutopay invoiceId={invoiceId} /> : null}
              {can.write ? <TurnOffAutopay invoiceId={invoiceId} label="Turn off auto-pay" /> : null}
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}

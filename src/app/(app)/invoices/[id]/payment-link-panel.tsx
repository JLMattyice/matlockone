"use client";

import { useActionState } from "react";

import {
  checkForPayment,
  createPaymentLink,
  removePaymentLink,
} from "../payment-link";
import { useTimeZone } from "@/components/app-shell/time-zone";
import { Button } from "@/components/ui/button";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { formatIn } from "@/lib/time-zone";

export type PaymentLinkPanelProps = {
  invoiceId: string;
  /** Null when nothing is connected under Settings → Payments. */
  processorLabel: string | null;
  processorReconciles: boolean;
  /** The processor reports payments here as they happen. */
  instant: boolean;
  /** The morning run asks about this link by itself. */
  checkedEachMorning: boolean;
  paymentUrl: string | null;
  paymentCheckedAt: string | null;
  /** The processor link cannot be polled — a pasted link, for instance. */
  hasRef: boolean;
  settled: boolean;
  canRecord: boolean;
  /**
   * The link asks for a different amount from what is owed now, so it is
   * left out of everything the client sees. With what it asks for and what
   * is owed, formatted; `asks` is null for a link made before that was kept.
   */
  stale: { asks: string | null; owed: string } | null;
};

export function PaymentLinkPanel({
  invoiceId,
  processorLabel,
  processorReconciles,
  instant,
  checkedEachMorning,
  paymentUrl,
  paymentCheckedAt,
  hasRef,
  settled,
  canRecord,
  stale,
}: PaymentLinkPanelProps) {
  const zone = useTimeZone();
  const [createState, createAction] = useActionState<ActionState, FormData>(
    createPaymentLink,
    IDLE,
  );
  const [checkState, checkAction] = useActionState<ActionState, FormData>(
    checkForPayment,
    IDLE,
  );

  if (!processorLabel) {
    return (
      <p className="text-xs text-ink-subtle">
        Connect a payment provider under Settings → Payments to add a Pay now
        link to this invoice.
      </p>
    );
  }

  if (!paymentUrl) {
    if (settled) return null;

    return (
      <form action={createAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <SubmitButton variant="secondary" size="sm" pendingLabel="Adding…">
          Add Pay now link
        </SubmitButton>
        <span className="text-xs text-ink-subtle">via {processorLabel}</span>
        <ActionStatus state={createState} />
      </form>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold tracking-wider text-ink-subtle uppercase">
        Pay now link · {processorLabel}
      </p>

      <p className="font-mono text-xs break-all text-ink-muted">{paymentUrl}</p>

      {stale ? (
        <p className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-ink">
          {stale.asks
            ? `This link asks for ${stale.asks}, but ${stale.owed} is owed now.`
            : `A payment has come in since this link was made, so it may ask for more than the ${stale.owed} owed now.`}{" "}
          It’s left out of emails, reminders, the PDF and the client’s invoice page. Remove it
          and add a new one for the right amount — the old one still works at {processorLabel}{" "}
          until you cancel it there.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {processorReconciles && hasRef && canRecord && !settled ? (
          <form action={checkAction} className="flex items-center gap-2">
            <input type="hidden" name="invoiceId" value={invoiceId} />
            <SubmitButton variant="secondary" size="sm" pendingLabel="Checking…">
              Check for payment
            </SubmitButton>
          </form>
        ) : null}

        <form action={removePaymentLink}>
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <Button type="submit" variant="ghost" size="sm">
            Remove link
          </Button>
        </form>

        <ActionStatus state={checkState} />
      </div>

      {!processorReconciles || !hasRef ? (
        <p className="text-xs text-ink-subtle">
          {processorLabel} cannot tell Matlock One what it collected, so record
          the payment below once it lands.
        </p>
      ) : (
        <CheckedNote
          lines={[
            settled
              ? null
              : instant
                ? `${processorLabel} tells Matlock One the moment this is paid.`
                : checkedEachMorning
                  ? `Checked with ${processorLabel} every morning.`
                  : null,
            paymentCheckedAt
              ? `Last checked ${formatIn(paymentCheckedAt, "MMM d, yyyy 'at' h:mm a", zone)}.`
              : null,
          ]}
        />
      )}
    </div>
  );
}

/** How this link gets checked, and when it last was — whichever are known. */
function CheckedNote({ lines }: { lines: (string | null)[] }) {
  const text = lines.filter(Boolean).join(" ");
  return text ? <p className="text-xs text-ink-subtle">{text}</p> : null;
}

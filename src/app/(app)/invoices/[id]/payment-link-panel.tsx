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

"use client";

import { useActionState } from "react";

import {
  checkInvoiceAutopay,
  emailAutopayInvite,
  offerInvoiceAutopay,
  turnOffInvoiceAutopay,
} from "../autopay";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Input } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

/**
 * The buttons on the Auto-pay card. Each is its own form with its own
 * answer, since each talks to PayPal or the outbox and can be refused on its
 * own terms.
 */

export function OfferAutopay({ invoiceId }: { invoiceId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(offerInvoiceAutopay, IDLE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <SubmitButton variant="outline" size="sm" pendingLabel="Setting up at PayPal…">
        Offer auto-pay
      </SubmitButton>
      <ActionStatus state={state} className="text-xs" />
    </form>
  );
}

export function EmailInvite({
  invoiceId,
  defaultEmail,
}: {
  invoiceId: string;
  defaultEmail: string | null;
}) {
  const [state, action] = useActionState<ActionState, FormData>(emailAutopayInvite, IDLE);
  const keep = useKeepTyped(state);

  return (
    <form ref={keep} action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          name="email"
          type="email"
          defaultValue={defaultEmail ?? ""}
          placeholder="customer@example.com"
          aria-label="Send the invite to"
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <SubmitButton variant="secondary" size="sm" pendingLabel="Sending…">
          Email the invite
        </SubmitButton>
      </div>
      {state.fieldErrors?.email ? (
        <p className="text-xs text-danger">{state.fieldErrors.email}</p>
      ) : null}
      <ActionStatus state={state} className="text-xs" />
    </form>
  );
}

export function CheckAutopay({ invoiceId }: { invoiceId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(checkInvoiceAutopay, IDLE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Asking PayPal…">
        Check now
      </SubmitButton>
      <ActionStatus state={state} className="text-xs" />
    </form>
  );
}

export function TurnOffAutopay({
  invoiceId,
  label,
}: {
  invoiceId: string;
  label: string;
}) {
  const [state, action] = useActionState<ActionState, FormData>(turnOffInvoiceAutopay, IDLE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <ConfirmButton variant="ghost" size="sm" confirmLabel="Turn it off?" pendingLabel="Cancelling at PayPal…">
        {label}
      </ConfirmButton>
      <ActionStatus state={state} className="text-xs" />
    </form>
  );
}

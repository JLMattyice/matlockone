"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { Banknote } from "lucide-react";

import { markInvoicePaid, recordPayment, sendInvoice } from "../actions";
import { buttonClasses } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { IDLE, type ActionState } from "@/lib/action-state";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function PaymentForm({
  invoiceId,
  balanceCents,
  currencySymbol,
  today,
}: {
  invoiceId: string;
  balanceCents: number;
  currencySymbol: string;
  today: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    recordPayment,
    IDLE,
  );
  const formRef = useRef<HTMLFormElement>(null);

  // React clears the form when the save returns; this puts the typing
  // back when the answer was a refusal.
  const keep = useKeepTyped(state);
  // One ref for both: formRef clears the form after a payment is recorded,
  // keep puts it back after a refusal.
  const attach = useCallback(
    (element: HTMLFormElement | null) => {
      formRef.current = element;
      return keep(element);
    },
    [keep],
  );
  const [amount, setAmount] = useState((balanceCents / 100).toFixed(2));

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={attach} action={formAction} className="space-y-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Amount" htmlFor="amount" required error={state.fieldErrors?.amount}>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-subtle">
              {currencySymbol}
            </span>
            <Input
              id="amount"
              name="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              required
              className="tabular pl-7"
            />
          </div>
        </Field>

        <Field label="Method" htmlFor="method">
          <Select id="method" name="method" defaultValue="CARD">
            {PAYMENT_METHODS.map((method) => (
              <option key={method} value={method}>
                {PAYMENT_METHOD_LABELS[method]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Received"
          htmlFor="receivedAt"
          required
          error={state.fieldErrors?.receivedAt}
        >
          <Input
            id="receivedAt"
            name="receivedAt"
            type="date"
            defaultValue={today}
            required
          />
        </Field>

        <Field label="Reference" htmlFor="reference" hint="Check number, transaction id.">
          <Input id="reference" name="reference" placeholder="Optional" />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setAmount((balanceCents / 100).toFixed(2))}
          className="text-xs text-brand hover:underline"
        >
          Pay full balance
        </button>

        <ActionStatus state={state} className="text-xs" />

        <SubmitButton size="sm" className="ml-auto" pendingLabel="Recording…">
          Record payment
        </SubmitButton>
      </div>
    </form>
  );
}

/**
 * Paid in full some other way — cash, a check, a card machine, a transfer —
 * in a couple of taps: how it was paid, and the day if it was not today.
 */
export function MarkPaid({
  invoiceId,
  owed,
  today,
  isDraft,
  receiptTo,
}: {
  invoiceId: string;
  /** What is still owed, formatted: the amount the payment will be for. */
  owed: string;
  today: string;
  isDraft: boolean;
  /** The client's name when they have an email address for the receipt. */
  receiptTo: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<ActionState, FormData>(
    markInvoicePaid,
    IDLE,
  );

  // React clears the form when the save returns; this puts the typing
  // back when the answer was a refusal.
  const keep = useKeepTyped(state);

  if (state.ok) {
    return <span className="text-sm text-success">{state.message}</span>;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses("outline", "md")}
      >
        <Banknote className="h-3.5 w-3.5" strokeWidth={2} />
        Mark as paid
      </button>
    );
  }

  const notes = [
    isDraft ? "It hasn’t been sent — this issues it as paid, without emailing the invoice." : null,
    receiptTo ? `${receiptTo} gets a receipt by email.` : null,
  ].filter(Boolean);

  return (
    <form
      ref={keep}
      action={formAction}
      className="w-full space-y-4 rounded-lg border border-line bg-surface p-4"
    >
      <input type="hidden" name="id" value={invoiceId} />

      <div>
        <p className="text-sm font-semibold text-ink">
          Mark <span className="tabular">{owed}</span> as paid
        </p>
        <p className="text-xs text-ink-muted">For money that came in outside Matlock One.</p>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-ink-muted">How was it paid?</legend>
        <div className="flex flex-wrap gap-1.5">
          {PAYMENT_METHODS.map((method) => (
            <label key={method} className="cursor-pointer">
              <input
                type="radio"
                name="method"
                value={method}
                defaultChecked={method === "CASH"}
                className="peer sr-only"
              />
              <span
                className={cn(
                  "inline-flex items-center rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors",
                  "hover:bg-surface-3 peer-checked:border-brand peer-checked:bg-brand peer-checked:text-brand-ink",
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40",
                )}
              >
                {PAYMENT_METHOD_LABELS[method]}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Received"
          htmlFor="markPaidOn"
          required
          error={state.fieldErrors?.receivedAt}
        >
          <Input id="markPaidOn" name="receivedAt" type="date" defaultValue={today} required />
        </Field>

        <Field label="Reference" htmlFor="markPaidReference" hint="Check number, transfer note.">
          <Input id="markPaidReference" name="reference" placeholder="Optional" />
        </Field>
      </div>

      {notes.length ? <p className="text-xs text-ink-subtle">{notes.join(" ")}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pendingLabel="Saving…">
          Mark paid · <span className="tabular">{owed}</span>
        </SubmitButton>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={buttonClasses("ghost", "md")}
        >
          Cancel
        </button>
        <ActionStatus state={state} className="text-xs" />
      </div>
    </form>
  );
}

/** Send, with a chance to correct the address first. */
export function SendInvoice({
  invoiceId,
  defaultEmail,
  alreadySent,
}: {
  invoiceId: string;
  defaultEmail: string | null;
  alreadySent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<ActionState, FormData>(
    sendInvoice,
    IDLE,
  );

  // React clears the form when the save returns; this puts the typing
  // back when the answer was a refusal.
  const keep = useKeepTyped(state);

  if (state.ok) {
    return <span className="text-sm text-success">{state.message}</span>;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses(alreadySent ? "outline" : "primary", "md")}
      >
        {alreadySent ? "Send again" : "Send invoice"}
      </button>
    );
  }

  return (
    <form ref={keep} action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={invoiceId} />

      <Field label="Send to" htmlFor="email" error={state.fieldErrors?.email}>
        <Input
          id="email"
          name="email"
          type="email"
          defaultValue={defaultEmail ?? ""}
          className="w-64"
          autoFocus
        />
      </Field>

      <SubmitButton pendingLabel="Sending…">Send</SubmitButton>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className={buttonClasses("ghost", "md")}
      >
        Cancel
      </button>

      <ActionStatus state={state} className="w-full" />
    </form>
  );
}

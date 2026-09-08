"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { recordPayment, sendInvoice } from "../actions";
import { buttonClasses } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@/lib/constants";

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
  const [amount, setAmount] = useState((balanceCents / 100).toFixed(2));

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />

      <div className="grid gap-3 sm:grid-cols-2">
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
    <form action={formAction} className="flex flex-wrap items-end gap-2">
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

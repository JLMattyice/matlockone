"use client";

import { useActionState, useEffect, useState } from "react";

import { scheduleInvoiceSend } from "../actions";
import { buttonClasses } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

/**
 * Send later: the day a draft is emailed to the client.
 *
 * Opened from beside Send invoice, and from the note saying when it goes, to
 * change the day or the address. The form takes a whole row of its own,
 * below the buttons beside it, so it reads apart from them.
 */
export function SendLater({
  invoiceId,
  defaultEmail,
  defaultDate,
  minDate,
  maxDate,
  label = "Send later",
}: {
  invoiceId: string;
  defaultEmail: string | null;
  /** yyyy-MM-dd: the day already chosen, or the invoice's own date if later. */
  defaultDate: string;
  minDate: string;
  maxDate: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<ActionState, FormData>(
    scheduleInvoiceSend,
    IDLE,
  );
  const keep = useKeepTyped(state);

  // The page now says when it goes; the form has done its job.
  useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses("outline", "md")}
      >
        {label}
      </button>
    );
  }

  return (
    <form
      ref={keep}
      action={formAction}
      className="order-last w-full space-y-3 rounded-lg border border-line bg-surface p-4"
    >
      <input type="hidden" name="id" value={invoiceId} />

      <div className="flex flex-wrap items-start gap-3">
        <Field label="Send to" htmlFor="send-later-email" error={state.fieldErrors?.email}>
          <Input
            id="send-later-email"
            name="email"
            type="email"
            defaultValue={defaultEmail ?? ""}
            className="w-64"
            autoFocus
          />
        </Field>

        <Field label="Send on" htmlFor="send-later-date" error={state.fieldErrors?.sendOn}>
          <Input
            id="send-later-date"
            name="sendOn"
            type="date"
            defaultValue={defaultDate}
            min={minDate}
            max={maxDate}
            required
          />
        </Field>
      </div>

      <p className="text-xs text-ink-subtle">
        Emailed that morning with its PDF and pay link, the same as pressing Send.
        The invoice is dated that day, and its due date moves with it.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pendingLabel="Saving…">Set the day</SubmitButton>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={buttonClasses("ghost", "md")}
        >
          Cancel
        </button>
      </div>

      <ActionStatus state={state} className="text-xs" />
    </form>
  );
}

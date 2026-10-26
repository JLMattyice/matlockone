"use client";

import { useActionState, useEffect, useState } from "react";
import { format } from "date-fns";

import { saveInvoiceRepeat } from "../repeat";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  INVOICE_REPEAT_FREQUENCIES,
  type InvoiceRepeatFrequency,
} from "@/lib/constants";
import { nextNotBefore } from "@/lib/recurrence";

const PERIODS: Record<InvoiceRepeatFrequency, [one: string, many: string]> = {
  WEEKLY: ["Week", "Weeks"],
  MONTHLY: ["Month", "Months"],
  YEARLY: ["Year", "Years"],
};

/** A yyyy-MM-dd from a date input, as the local noon every form here uses. */
const noon = (value: string) => new Date(`${value}T12:00:00`);

/**
 * The repeat settings, opened from the Repeat card.
 *
 * Until the date is touched, it follows the rhythm: one period on from the
 * latest invoice in the series, or the first date in that rhythm that has not
 * already gone by. Change "Month" to "Year" and the date moves to match,
 * rather than leaving a monthly date under a yearly repeat.
 */
export function RepeatForm({
  invoiceId,
  baseDate,
  today,
  initial,
  openLabel,
  aside,
}: {
  invoiceId: string;
  /** The latest issue date in the series, which the default next date follows. */
  baseDate: string;
  today: string;
  /** The schedule's current settings, when there is one. */
  initial: {
    frequency: InvoiceRepeatFrequency;
    interval: number;
    nextIssueDate: string;
    endDate: string | null;
    autoSend: boolean;
  } | null;
  openLabel: string;
  /** Shown beside the button while the form is closed — the Stop button. */
  aside?: React.ReactNode;
}) {
  const [state, action] = useActionState<ActionState, FormData>(saveInvoiceRepeat, IDLE);
  const keep = useKeepTyped(state);

  const [open, setOpen] = useState(false);
  const [frequency, setFrequency] = useState<InvoiceRepeatFrequency>(
    initial?.frequency ?? "MONTHLY",
  );
  const [every, setEvery] = useState(String(initial?.interval ?? 1));
  const [autoSend, setAutoSend] = useState(initial?.autoSend ?? false);
  const [dateTouched, setDateTouched] = useState(false);

  const suggested = (f: InvoiceRepeatFrequency, n: string) =>
    format(
      nextNotBefore(noon(baseDate), f, Math.max(1, Number(n) || 1), new Date(`${today}T00:00:00`)),
      "yyyy-MM-dd",
    );

  const [next, setNext] = useState(initial?.nextIssueDate ?? suggested(frequency, every));

  function follow(f: InvoiceRepeatFrequency, n: string) {
    if (!dateTouched) setNext(suggested(f, n));
  }

  useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state]);

  // Read from the props as they are when the form opens, not when the page
  // first drew it: Send later moves this invoice's date without leaving the
  // page, and the suggested next date has to follow it.
  function openForm() {
    setNext(initial?.nextIssueDate ?? suggested(frequency, every));
    setAutoSend(initial?.autoSend ?? false);
    setDateTouched(false);
    setOpen(true);
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={openForm}>
            {openLabel}
          </Button>
          {aside}
        </div>
        <ActionStatus state={state} className="text-xs" />
      </div>
    );
  }

  const plural = Number(every) !== 1;

  return (
    <form ref={keep} action={action} className="space-y-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />

      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3">
        <Field label="Every" htmlFor="repeat-interval" error={state.fieldErrors?.interval}>
          <Input
            id="repeat-interval"
            name="interval"
            type="number"
            min={1}
            max={24}
            value={every}
            onChange={(e) => {
              setEvery(e.target.value);
              follow(frequency, e.target.value);
            }}
            className="tabular"
          />
        </Field>

        <Field label="Period" htmlFor="repeat-frequency">
          <Select
            id="repeat-frequency"
            name="frequency"
            value={frequency}
            onChange={(e) => {
              const value = e.target.value as InvoiceRepeatFrequency;
              setFrequency(value);
              follow(value, every);
            }}
          >
            {INVOICE_REPEAT_FREQUENCIES.map((option) => (
              <option key={option} value={option}>
                {PERIODS[option][plural ? 1 : 0]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-ink">Each time</legend>
        <Choice
          value="DRAFT"
          checked={!autoSend}
          onChange={() => setAutoSend(false)}
          title="Make a draft for me to check"
          detail="You're told when it's ready. Nothing goes to the client until you send it."
        />
        <Choice
          value="SEND"
          checked={autoSend}
          onChange={() => setAutoSend(true)}
          title="Send it to the client"
          detail="Emailed with its PDF and pay link on the morning of its date. You hear only if it can't go."
        />
      </fieldset>

      <Field
        label={autoSend ? "Next one on" : "Next draft on"}
        htmlFor="repeat-next"
        error={state.fieldErrors?.nextIssueDate}
        hint={
          autoSend
            ? "The new invoice's issue date, and the day it's sent. Today sends it now."
            : "The new invoice's issue date. Today makes it now."
        }
      >
        <Input
          id="repeat-next"
          name="nextIssueDate"
          type="date"
          value={next}
          onChange={(e) => {
            setNext(e.target.value);
            setDateTouched(true);
          }}
          required
        />
      </Field>

      <Field
        label="Stop after"
        htmlFor="repeat-end"
        error={state.fieldErrors?.endDate}
        hint="Optional. Leave empty to keep going until you stop it."
      >
        <Input
          id="repeat-end"
          name="endDate"
          type="date"
          min={next}
          defaultValue={initial?.endDate ?? ""}
        />
      </Field>

      <p className="text-xs text-ink-subtle">
        Each one copies the latest invoice in the series, so a change you make
        to one carries forward.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" pendingLabel="Saving…">
          Save repeat
        </SubmitButton>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>

      <ActionStatus state={state} className="text-xs" />
    </form>
  );
}

function Choice({
  value,
  checked,
  onChange,
  title,
  detail,
}: {
  value: "DRAFT" | "SEND";
  checked: boolean;
  onChange: () => void;
  title: string;
  detail: string;
}) {
  return (
    <label className="flex cursor-pointer gap-2.5 rounded-lg border border-line px-3 py-2.5 transition-colors hover:border-line-strong has-checked:border-brand has-checked:bg-brand/10 has-focus-visible:ring-2 has-focus-visible:ring-brand/40">
      <input
        type="radio"
        name="autoSend"
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-1 accent-brand"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block text-xs text-ink-muted">{detail}</span>
      </span>
    </label>
  );
}

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

  if (!open) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
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

      <Field
        label="Next draft on"
        htmlFor="repeat-next"
        error={state.fieldErrors?.nextIssueDate}
        hint="The new invoice's issue date. Today makes it now."
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
        Each draft copies the latest invoice in the series, so a change you make
        to one carries forward. Nothing is sent until you send it.
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

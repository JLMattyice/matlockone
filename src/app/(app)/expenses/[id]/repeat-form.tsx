"use client";

import { useActionState, useEffect, useState } from "react";
import { format } from "date-fns";

import { saveExpenseRepeat } from "../repeat";
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
 * The repeat settings, opened from the Repeat card on an expense.
 *
 * Until the date is touched it follows the rhythm: one period on from the
 * latest expense in the series, or the first date in that rhythm that has not
 * already gone by.
 */
export function ExpenseRepeatForm({
  expenseId,
  baseDate,
  today,
  initial,
  openLabel,
  aside,
}: {
  expenseId: string;
  /** The latest date in the series, which the default next date follows. */
  baseDate: string;
  today: string;
  initial: {
    frequency: InvoiceRepeatFrequency;
    interval: number;
    nextDate: string | null;
    endDate: string | null;
    amountVaries: boolean;
  };
  openLabel: string;
  /** Shown beside the button while the form is closed — the Stop button. */
  aside?: React.ReactNode;
}) {
  const [state, action] = useActionState<ActionState, FormData>(saveExpenseRepeat, IDLE);
  const keep = useKeepTyped(state);

  const [open, setOpen] = useState(false);
  const [frequency, setFrequency] = useState<InvoiceRepeatFrequency>(initial.frequency);
  const [every, setEvery] = useState(String(initial.interval));
  const [dateTouched, setDateTouched] = useState(false);

  const suggested = (f: InvoiceRepeatFrequency, n: string) =>
    format(
      nextNotBefore(noon(baseDate), f, Math.max(1, Number(n) || 1), new Date(`${today}T00:00:00`)),
      "yyyy-MM-dd",
    );

  const [next, setNext] = useState(initial.nextDate ?? suggested(frequency, every));

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
      <input type="hidden" name="expenseId" value={expenseId} />

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
          value="FIXED"
          defaultChecked={!initial.amountVaries}
          title="Same amount every time"
          detail="Rent, software, insurance. Recorded by itself on the date."
        />
        <Choice
          value="VARIES"
          defaultChecked={initial.amountVaries}
          title="The amount changes"
          detail="Utilities, fuel cards. You get a task to enter the real bill; nothing is recorded until you do."
        />
      </fieldset>

      <Field
        label="Next one on"
        htmlFor="repeat-next"
        error={state.fieldErrors?.nextDate}
        hint="Today does it now."
      >
        <Input
          id="repeat-next"
          name="nextDate"
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
          defaultValue={initial.endDate ?? ""}
        />
      </Field>

      <p className="text-xs text-ink-subtle">
        Each one copies the latest expense in the series, so a change you make
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
  defaultChecked,
  title,
  detail,
}: {
  value: "FIXED" | "VARIES";
  defaultChecked: boolean;
  title: string;
  detail: string;
}) {
  return (
    <label className="flex cursor-pointer gap-2.5 rounded-lg border border-line px-3 py-2.5 transition-colors hover:border-line-strong has-checked:border-brand has-checked:bg-brand/10 has-focus-visible:ring-2 has-focus-visible:ring-brand/40">
      <input
        type="radio"
        name="amountVaries"
        value={value}
        defaultChecked={defaultChecked}
        className="mt-1 accent-brand"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block text-xs text-ink-muted">{detail}</span>
      </span>
    </label>
  );
}

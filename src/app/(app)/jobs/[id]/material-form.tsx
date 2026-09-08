"use client";

import { useActionState, useEffect, useRef } from "react";

import { addJobMaterial } from "../actions";
import { Checkbox, Input } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

export function MaterialForm({
  jobId,
  currencySymbol,
}: {
  jobId: string;
  currencySymbol: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    addJobMaterial,
    IDLE,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="jobId" value={jobId} />

      <div className="grid gap-2 sm:grid-cols-[1fr_5rem_5rem_7rem]">
        <Input
          name="name"
          required
          placeholder="Material or part"
          aria-label="Material name"
          aria-invalid={Boolean(state.fieldErrors?.name)}
        />
        <Input
          name="quantity"
          type="number"
          step="0.01"
          min="0.01"
          defaultValue="1"
          aria-label="Quantity"
          className="tabular"
        />
        <Input
          name="unit"
          defaultValue="ea"
          aria-label="Unit"
          placeholder="ea"
        />
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-subtle">
            {currencySymbol}
          </span>
          <Input
            name="unitCost"
            inputMode="decimal"
            placeholder="0.00"
            aria-label="Unit cost"
            className="tabular pl-7"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <Checkbox name="billable" defaultChecked />
          Billable to the client
        </label>

        <ActionStatus state={state} className="text-xs" />

        {state.fieldErrors?.name ? (
          <p className="text-xs text-danger">{state.fieldErrors.name}</p>
        ) : null}

        <SubmitButton size="sm" variant="outline" className="ml-auto">
          Add material
        </SubmitButton>
      </div>
    </form>
  );
}

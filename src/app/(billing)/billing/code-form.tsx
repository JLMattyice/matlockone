"use client";

import { useActionState } from "react";

import { enterTrialCode } from "./actions";
import { Input } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE } from "@/lib/action-state";
import { TRIAL_CODE_MAX } from "@/lib/billing/trial-codes";

/**
 * "Have a code?" on the billing screen. Accepted, the page redraws with the
 * code on and the free month beside each monthly plan, so this form goes; a
 * refusal stays here, with what was typed still in the box.
 */
export function TrialCodeForm({ initial }: { initial: string }) {
  const [state, action] = useActionState(enterTrialCode, IDLE);
  const ref = useKeepTyped(state);

  return (
    <form ref={ref} action={action} className="space-y-1.5">
      <label htmlFor="trial-code" className="block text-sm font-medium text-ink">
        Have a code?
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="trial-code"
          name="code"
          defaultValue={initial}
          // Room for the spaces somebody might type, which are dropped.
          maxLength={TRIAL_CODE_MAX + 8}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={state.ok === false ? true : undefined}
          className="max-w-56 uppercase"
        />
        <SubmitButton variant="outline" size="md" pendingLabel="Checking…">
          Apply
        </SubmitButton>
      </div>
      <ActionStatus state={state} />
    </form>
  );
}

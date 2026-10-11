"use client";

import { createContext, useActionState, useContext, useState, type ReactNode } from "react";

import { enterTrialCode } from "./actions";
import { Input } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE } from "@/lib/action-state";
import { TRIAL_CODE_MAX } from "@/lib/billing/trial-codes";

/**
 * What is in the "Have a code?" box right now, shared with the plan buttons.
 *
 * Somebody who types a code and goes straight to a plan, without pressing
 * Apply, still meant to use it. Each plan's form carries the box's contents
 * (TypedCode), so choosing the plan applies the code first — and a code that
 * does not work stops there, instead of the plan going ahead at full price.
 */
const TypedCodeContext = createContext<{ typed: string; setTyped: (value: string) => void }>({
  typed: "",
  setTyped: () => {},
});

export function TrialCodeProvider({ initial, children }: { initial: string; children: ReactNode }) {
  const [typed, setTyped] = useState(initial);
  return <TypedCodeContext.Provider value={{ typed, setTyped }}>{children}</TypedCodeContext.Provider>;
}

/** Inside a plan's form: the code from the box, if anything is in it. */
export function TypedCode() {
  const { typed } = useContext(TypedCodeContext);
  return typed.trim() ? <input type="hidden" name="code" value={typed} /> : null;
}

/**
 * "Have a code?" on the billing screen. Accepted, the page redraws with the
 * code on and a free month offered on each plan, so this form goes; a refusal
 * stays here, with what was typed still in the box.
 */
export function TrialCodeForm() {
  const { typed, setTyped } = useContext(TypedCodeContext);
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
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
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

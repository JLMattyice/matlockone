"use client";

import { useActionState, useState } from "react";
import { Check, Copy } from "lucide-react";

import { createTrialCode } from "./actions";
import { Field, Input } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE } from "@/lib/action-state";
import { TRIAL_CODE_MAX, TRIAL_NOTE_MAX, TRIAL_USES_MAX } from "@/lib/billing/trial-codes";

/** Making a free-month code. Everything is optional; a blank code is made up. */
export function NewTrialCodeForm({ today }: { today: string }) {
  const [state, action] = useActionState(createTrialCode, IDLE);
  const ref = useKeepTyped(state);
  const errors = state.fieldErrors ?? {};

  return (
    <form ref={ref} action={action} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code" htmlFor="trial-code" hint="Leave empty to make one up." error={errors.code}>
          <Input
            id="trial-code"
            name="code"
            placeholder="FRIEND30"
            maxLength={TRIAL_CODE_MAX + 8}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.code ? true : undefined}
            className="uppercase placeholder:normal-case"
          />
        </Field>
        <Field label="Who it’s for" htmlFor="trial-note" hint="Only you see this." error={errors.note}>
          <Input
            id="trial-note"
            name="note"
            placeholder="BNI chapter"
            maxLength={TRIAL_NOTE_MAX}
            aria-invalid={errors.note ? true : undefined}
          />
        </Field>
        <Field
          label="How many businesses"
          htmlFor="trial-uses"
          hint="Empty for no limit."
          error={errors.maxUses}
        >
          <Input
            id="trial-uses"
            name="maxUses"
            type="number"
            inputMode="numeric"
            min={1}
            max={TRIAL_USES_MAX}
            step={1}
            placeholder="No limit"
            aria-invalid={errors.maxUses ? true : undefined}
          />
        </Field>
        <Field label="Last day it works" htmlFor="trial-last-day" hint="Empty for no end." error={errors.lastDay}>
          <Input
            id="trial-last-day"
            name="lastDay"
            type="date"
            min={today}
            aria-invalid={errors.lastDay ? true : undefined}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="md" pendingLabel="Making…">
          Make code
        </SubmitButton>
        <ActionStatus state={state} />
      </div>
    </form>
  );
}

/** A code's sign-up link, with a button that copies it. */
export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the link beside the button can still be selected.
    }
  }

  return (
    <span className="mt-0.5 flex items-center gap-1.5">
      <span className="text-xs break-all text-ink-subtle select-all">{url}</span>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded p-1 text-ink-subtle hover:bg-surface-3 hover:text-ink"
        aria-label={copied ? "Link copied" : "Copy sign-up link"}
        title={copied ? "Copied" : "Copy link"}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" strokeWidth={2} />
        ) : (
          <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
        )}
      </button>
    </span>
  );
}

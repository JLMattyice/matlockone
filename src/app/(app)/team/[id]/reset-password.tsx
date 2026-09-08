"use client";

import { useActionState, useState } from "react";
import { KeyRound } from "lucide-react";

import { resetTeamMemberPassword } from "../actions";
import { buttonClasses } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Field, Input } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

/**
 * Sets a new password for someone else. Deliberately a disclosure rather than a
 * always-visible field — it signs them out everywhere, so it should take an
 * intentional click to reach.
 */
export function ResetPassword({ memberId }: { memberId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<ActionState, FormData>(
    resetTeamMemberPassword,
    IDLE,
  );

  if (state.ok) {
    return <p className="text-sm text-success">{state.message}</p>;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses("outline", "md")}
      >
        <KeyRound className="h-3.5 w-3.5" strokeWidth={2} />
        Reset password
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={memberId} />

      <Field
        label="New password"
        htmlFor="password"
        required
        error={state.fieldErrors?.password}
        hint="Signs them out of every device."
      >
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          required
          autoFocus
          className="w-56"
        />
      </Field>

      <SubmitButton pendingLabel="Resetting…">Set password</SubmitButton>
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

"use client";

import { useActionState } from "react";

import { banBusinessAction, deleteBusinessAction } from "../actions";
import { Field, Input, Textarea } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { BAN_REASON_MAX } from "@/lib/account-bans-limits";
import { IDLE } from "@/lib/action-state";

/** Banning a business, with the reason kept on record. */
export function BanForm({ id }: { id: string }) {
  const [state, action] = useActionState(banBusinessAction, IDLE);
  const ref = useKeepTyped(state);
  const errors = state.fieldErrors ?? {};

  return (
    <form ref={ref} action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <Field
        label="Why"
        htmlFor="ban-reason"
        hint="Only you see this. Which part of the terms, and what happened."
        error={errors.reason}
      >
        <Textarea
          id="ban-reason"
          name="reason"
          rows={3}
          maxLength={BAN_REASON_MAX}
          aria-invalid={errors.reason ? true : undefined}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="danger" size="md" pendingLabel="Banning…">
          Ban this business
        </SubmitButton>
        <ActionStatus state={state} />
      </div>
    </form>
  );
}

/** Deleting a business for good, confirmed by typing its name. */
export function DeleteForm({ id, name }: { id: string; name: string }) {
  const [state, action] = useActionState(deleteBusinessAction, IDLE);
  const ref = useKeepTyped(state);
  const errors = state.fieldErrors ?? {};

  return (
    <form ref={ref} action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <Field
        label={`Type “${name}” to confirm`}
        htmlFor="delete-confirm"
        error={errors.confirm}
      >
        <Input
          id="delete-confirm"
          name="confirm"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errors.confirm ? true : undefined}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="danger" size="md" pendingLabel="Deleting…">
          Delete forever
        </SubmitButton>
        <ActionStatus state={state} />
      </div>
    </form>
  );
}

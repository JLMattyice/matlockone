"use client";

import { useActionState, useEffect, useRef } from "react";

import { addNote } from "@/app/(app)/notes/actions";
import { Checkbox, Textarea } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import type { NoteEntityType } from "@/lib/note-entities";

export function NoteComposer({
  entityType,
  entityId,
  placeholder = "Add a note…",
}: {
  entityType: NoteEntityType;
  entityId: string;
  placeholder?: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(addNote, IDLE);
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the box once the note is saved, so a second note does not start with
  // the text of the first still in it.
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />

      <Textarea
        name="body"
        rows={3}
        required
        placeholder={placeholder}
        aria-label="Note"
        aria-invalid={Boolean(state.fieldErrors?.body)}
      />

      {state.fieldErrors?.body ? (
        <p className="text-xs text-danger">{state.fieldErrors.body}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <Checkbox name="visibility" value="SHARED" />
          Visible to the client on documents
        </label>

        <ActionStatus state={state} className="text-xs" />

        <SubmitButton size="sm" className="ml-auto" pendingLabel="Saving…">
          Add note
        </SubmitButton>
      </div>
    </form>
  );
}

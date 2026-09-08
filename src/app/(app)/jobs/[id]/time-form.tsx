"use client";

import { useActionState, useEffect, useRef } from "react";

import { addTimeEntry } from "../actions";
import { Checkbox, Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

export function TimeForm({
  jobId,
  crew,
  currentUserId,
  canLogForOthers,
  defaultStart,
}: {
  jobId: string;
  crew: { id: string; name: string }[];
  currentUserId: string;
  canLogForOthers: boolean;
  defaultStart: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    addTimeEntry,
    IDLE,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="jobId" value={jobId} />
      {canLogForOthers ? null : (
        <input type="hidden" name="userId" value={currentUserId} />
      )}

      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_6rem]">
        {canLogForOthers ? (
          <Select name="userId" defaultValue={currentUserId} aria-label="Who">
            {crew.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            value={crew.find((m) => m.id === currentUserId)?.name ?? "You"}
            disabled
            aria-label="Who"
          />
        )}

        <Input
          name="startedAt"
          type="datetime-local"
          defaultValue={defaultStart}
          required
          aria-label="Started at"
          aria-invalid={Boolean(state.fieldErrors?.startedAt)}
        />

        {/* step must divide evenly from `min`, or the browser rejects ordinary
            values: min=1 with step=15 makes 60 invalid. Stepping by 1 accepts
            whatever was actually worked. */}
        <Input
          name="minutes"
          type="number"
          min={1}
          max={1440}
          step={1}
          defaultValue={60}
          aria-label="Minutes worked"
          title="Minutes worked"
          className="tabular"
        />
      </div>

      <Input name="notes" placeholder="What was done (optional)" aria-label="Notes" />

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <Checkbox name="billable" defaultChecked />
          Billable
        </label>

        <ActionStatus state={state} className="text-xs" />

        {state.fieldErrors?.startedAt ? (
          <p className="text-xs text-danger">{state.fieldErrors.startedAt}</p>
        ) : null}

        <SubmitButton size="sm" variant="outline" className="ml-auto">
          Log time
        </SubmitButton>
      </div>
    </form>
  );
}

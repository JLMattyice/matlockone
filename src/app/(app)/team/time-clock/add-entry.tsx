"use client";

import { useActionState, useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { addClockEntry } from "./actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

/**
 * Enters a stretch nobody clocked: somebody forgot the clock for a whole day,
 * or is working now and never clocked in. For whoever can fix an entry; the
 * new one says who entered it, as a fixed one does.
 *
 * Folded away until asked for — most weeks nobody needs it.
 */
export function AddClockEntry({
  people,
  person,
  defaultIn,
  defaultOut,
  standalone = false,
}: {
  /** Who it can be for. Ignored when `person` fixes it. */
  people: { id: string; name: string }[];
  /** On one person's timesheet there is nobody to pick. */
  person?: { id: string; name: string };
  /** A start and end to begin from, as datetime-local values; either may be empty. */
  defaultIn: string;
  defaultOut: string;
  /** In a card of its own, not at the foot of another's table. */
  standalone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, add] = useActionState<ActionState, FormData>(addClockEntry, IDLE);
  const keep = useKeepTyped(state);

  useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state]);

  return (
    <div className={standalone ? "px-5 py-3" : "border-t border-line px-5 py-3"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-sm text-ink-muted">
          {person ? "A day missing from the clock?" : "Somebody missed the clock?"}
        </p>
        {/* Shown beside the button once the form has closed on a save. */}
        {open ? null : <ActionStatus state={state} className="text-xs" />}
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen((was) => !was)} aria-expanded={open}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          {open ? "Close" : "Add an entry"}
        </Button>
      </div>

      {open ? (
        <form ref={keep} action={add} className="mt-3 space-y-3 rounded-lg border border-line bg-surface-2 p-3">
          {person ? (
            <input type="hidden" name="userId" value={person.id} />
          ) : (
            <Field label="Who" htmlFor="add-clock-who" error={state.fieldErrors?.userId}>
              <Select id="add-clock-who" name="userId" defaultValue="" required>
                <option value="" disabled>
                  Pick somebody…
                </option>
                {people.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Clocked in" htmlFor="add-clock-in" error={state.fieldErrors?.in}>
              <Input id="add-clock-in" name="in" type="datetime-local" defaultValue={defaultIn} required />
            </Field>
            <Field
              label="Clocked out"
              htmlFor="add-clock-out"
              error={state.fieldErrors?.out}
              hint="Leave empty if they are still working."
            >
              <Input id="add-clock-out" name="out" type="datetime-local" defaultValue={defaultOut} />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            {/* Only a refusal: a form reopened after a save has nothing to report yet. */}
            <ActionStatus state={state.ok ? IDLE : state} className="mr-auto text-xs" />
            <SubmitButton size="sm" pendingLabel="Adding…">
              Add entry
            </SubmitButton>
          </div>
        </form>
      ) : null}
    </div>
  );
}

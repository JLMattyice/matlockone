"use client";

import { useActionState, useEffect, useState } from "react";
import { Pencil } from "lucide-react";

import { deleteClockEntry, fixClockEntry } from "./actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Field, Input } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

export type ClockRow = {
  id: string;
  person: string;
  day: string;
  inLabel: string;
  outLabel: string | null;
  hours: string;
  /** The times as the edit fields want them. */
  inValue: string;
  outValue: string;
  editedBy: string | null;
};

/** One stretch on the clock, which a manager can open and correct. */
export function ClockEntryRow({ row, canFix }: { row: ClockRow; canFix: boolean }) {
  const [editing, setEditing] = useState(false);
  const [state, save] = useActionState<ActionState, FormData>(fixClockEntry, IDLE);
  const keep = useKeepTyped(state);

  useEffect(() => {
    if (state.ok) setEditing(false);
  }, [state]);

  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{row.person}</p>
          <p className="tabular text-xs text-ink-muted">
            {row.day} · {row.inLabel} – {row.outLabel ?? "now"}
            {row.editedBy ? ` · fixed by ${row.editedBy}` : ""}
          </p>
        </div>
        {row.outLabel ? null : <Badge tone="success" dot>On the clock</Badge>}
        <span className="tabular text-sm font-semibold text-ink">{row.hours}</span>
        {canFix ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing((open) => !open)} aria-expanded={editing}>
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
            {editing ? "Close" : "Fix"}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface-2 p-3">
          <form ref={keep} action={save} className="space-y-3">
            <input type="hidden" name="id" value={row.id} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Clocked in" htmlFor={`in-${row.id}`} error={state.fieldErrors?.in}>
                <Input id={`in-${row.id}`} name="in" type="datetime-local" defaultValue={row.inValue} required />
              </Field>
              <Field
                label="Clocked out"
                htmlFor={`out-${row.id}`}
                error={state.fieldErrors?.out}
                hint={row.outLabel ? undefined : "Leave empty while they are still working."}
              >
                <Input id={`out-${row.id}`} name="out" type="datetime-local" defaultValue={row.outValue} />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <ActionStatus state={state} className="mr-auto text-xs" />
              <SubmitButton size="sm">Save</SubmitButton>
            </div>
          </form>
          <form action={deleteClockEntry} className="flex justify-end border-t border-line pt-3">
            <input type="hidden" name="id" value={row.id} />
            <ConfirmButton variant="outline" size="sm" confirmLabel="Delete it?" pendingLabel="Deleting…">
              Delete entry
            </ConfirmButton>
          </form>
        </div>
      ) : null}
    </li>
  );
}

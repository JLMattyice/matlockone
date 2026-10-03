"use client";

import { useActionState, useEffect, useOptimistic, useRef, useTransition } from "react";
import { Check, ListChecks, X } from "lucide-react";

import {
  addChecklistItems,
  applyChecklistTemplate,
  removeChecklistItem,
  setChecklistItemDone,
} from "../checklist-actions";
import { Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { cn } from "@/lib/utils";

export type ChecklistRow = {
  id: string;
  label: string;
  done: boolean;
  /** "Sam · Oct 3, 2:15 PM", already in the viewer's time zone. */
  doneNote: string | null;
};

type Change = { id: string; done?: boolean; removed?: boolean };

/**
 * The job's checklist. A tick shows the moment it is tapped and saves behind
 * it: on a phone with one bar of signal, waiting for the round trip before
 * the box fills in reads as the tap not having worked.
 */
export function JobChecklist({
  jobId,
  items,
  canTick,
  canEdit,
  templates,
}: {
  jobId: string;
  items: ChecklistRow[];
  canTick: boolean;
  canEdit: boolean;
  templates: { id: string; name: string; count: number }[];
}) {
  const [shown, change] = useOptimistic(items, (current: ChecklistRow[], next: Change) =>
    next.removed
      ? current.filter((item) => item.id !== next.id)
      : current.map((item) =>
          item.id === next.id ? { ...item, done: Boolean(next.done), doneNote: next.done ? item.doneNote : null } : item,
        ),
  );
  const [, startTransition] = useTransition();

  const tick = (item: ChecklistRow) =>
    startTransition(async () => {
      change({ id: item.id, done: !item.done });
      await setChecklistItemDone(item.id, !item.done);
    });

  const remove = (item: ChecklistRow) =>
    startTransition(async () => {
      change({ id: item.id, removed: true });
      await removeChecklistItem(item.id);
    });

  return (
    <div>
      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
          <ListChecks className="h-5 w-5 text-ink-subtle" strokeWidth={1.75} />
          <p className="text-sm font-medium text-ink">No checklist on this one</p>
          <p className="max-w-sm text-xs text-ink-muted">
            Add steps below, or save lists to reuse under Settings → Checklists — they can go
            on every new job in a category by themselves.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((item) => (
            <li key={item.id} className="flex items-start gap-1 pr-3">
              <button
                type="button"
                role="checkbox"
                aria-checked={item.done}
                disabled={!canTick}
                onClick={() => tick(item)}
                className="flex min-h-12 min-w-0 flex-1 items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors",
                    item.done ? "border-brand bg-brand text-white" : "border-line-strong bg-surface",
                  )}
                >
                  {item.done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0">
                  <span className={cn("block text-sm", item.done ? "text-ink-subtle line-through" : "text-ink")}>
                    {item.label}
                  </span>
                  {item.done && item.doneNote ? (
                    <span className="block text-xs text-ink-subtle">{item.doneNote}</span>
                  ) : null}
                </span>
              </button>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => remove(item)}
                  aria-label={`Remove ${item.label}`}
                  className="mt-2.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-danger/10 hover:text-danger"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <div className="space-y-3 border-t border-line p-5">
          <AddItem jobId={jobId} />
          {templates.length > 0 ? <AddSaved jobId={jobId} templates={templates} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function AddItem({ jobId }: { jobId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(addChecklistItems, IDLE);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={action} className="space-y-1.5">
      <input type="hidden" name="jobId" value={jobId} />
      <div className="flex gap-2">
        <Input
          name="items"
          placeholder="Add a step"
          aria-label="New checklist item"
          aria-invalid={Boolean(state.fieldErrors?.items)}
          maxLength={200}
        />
        <SubmitButton size="md" variant="outline" pendingLabel="Adding…">
          Add
        </SubmitButton>
      </div>
      {state.fieldErrors?.items ? (
        <p className="text-xs text-danger">{state.fieldErrors.items}</p>
      ) : (
        <ActionStatus state={state} className="text-xs" />
      )}
    </form>
  );
}

function AddSaved({ jobId, templates }: { jobId: string; templates: { id: string; name: string; count: number }[] }) {
  const [state, action] = useActionState<ActionState, FormData>(applyChecklistTemplate, IDLE);

  return (
    <form action={action} className="space-y-1.5">
      <input type="hidden" name="jobId" value={jobId} />
      <div className="flex gap-2">
        <Select name="templateId" aria-label="Saved checklist" defaultValue={templates[0].id}>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} ({template.count} {template.count === 1 ? "item" : "items"})
            </option>
          ))}
        </Select>
        <SubmitButton size="md" variant="outline" pendingLabel="Adding…" className="shrink-0">
          Add list
        </SubmitButton>
      </div>
      <ActionStatus state={state} className="text-xs" />
    </form>
  );
}

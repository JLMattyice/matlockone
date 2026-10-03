"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { ListChecks, Pencil, Plus } from "lucide-react";

import { deleteChecklistTemplate, saveChecklistTemplate } from "./actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  CHECKLIST_EXAMPLES,
  CHECKLIST_ITEM_MAX,
  CHECKLIST_MAX_ITEMS,
  CHECKLIST_NAME_MAX,
  MAX_CHECKLISTS,
} from "@/lib/checklists";
import { cn } from "@/lib/utils";

/** Settings → Checklists: the lists a business reuses on its jobs. */

export type SavedChecklist = {
  id: string;
  name: string;
  items: string[];
  /** A category picker value ("JOB", "category:…"), or "" for by hand. */
  appliesTo: string;
  /** What `appliesTo` reads as: "Job", "HVAC service". */
  appliesToLabel: string | null;
};

export type AppliesToOption = { value: string; label: string };

export function ChecklistSettingsForm({
  checklists,
  options,
  readOnly,
}: {
  checklists: SavedChecklist[];
  options: AppliesToOption[];
  readOnly: boolean;
}) {
  const full = checklists.length >= MAX_CHECKLISTS;

  return (
    <Card>
      <CardHeader
        title="Checklists"
        description="The steps a job goes through, ticked off on site. Put one on any job from its page, or pick a category and every new entry in it gets the list by itself. A job keeps its own copy, so a change here reaches what is booked from now on."
      />

      <CardBody className="space-y-3">
        {checklists.length === 0 ? (
          <p className="text-sm text-ink-muted">
            None yet.{" "}
            {readOnly
              ? "Ask an owner or admin to add some."
              : "Add one below, or start from an example."}
          </p>
        ) : (
          checklists.map((checklist) => (
            <ChecklistRow key={checklist.id} checklist={checklist} options={options} readOnly={readOnly} />
          ))
        )}
      </CardBody>

      {readOnly ? null : full ? (
        <CardFooter>
          <p className="mr-auto text-sm text-ink-muted">
            That is the most a business can keep ({MAX_CHECKLISTS}). Delete one you no longer use to
            add another.
          </p>
        </CardFooter>
      ) : (
        // Keyed on the count so a successful add starts the next one clean.
        <AddChecklist key={checklists.length} options={options} />
      )}
    </Card>
  );
}

function ChecklistRow({
  checklist,
  options,
  readOnly,
}: {
  checklist: SavedChecklist;
  options: AppliesToOption[];
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div
      className={cn(
        "rounded-card border transition-colors",
        editing ? "border-brand/30 bg-brand/4" : "border-line",
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <ListChecks className="h-4 w-4" strokeWidth={1.75} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            <span className="truncate">{checklist.name}</span>
            {checklist.appliesToLabel ? (
              <Badge tone="accent">Every new {checklist.appliesToLabel}</Badge>
            ) : null}
          </p>
          <p className="text-xs text-ink-subtle">
            {checklist.items.length} {checklist.items.length === 1 ? "item" : "items"}
            {checklist.appliesToLabel ? "" : " · put on by hand"}
          </p>
        </div>

        {readOnly ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
            {editing ? "Close" : "Edit"}
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-4 border-t border-line px-4 py-4">
          <EditChecklist checklist={checklist} options={options} onSaved={() => setEditing(false)} />

          <form action={deleteChecklistTemplate} className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <input type="hidden" name="id" value={checklist.id} />
            <p className="mr-auto text-xs text-ink-subtle">
              Jobs that already have these items keep them.
            </p>
            <ConfirmButton variant="outline" size="sm" confirmLabel="Delete it?" pendingLabel="Deleting…">
              Delete checklist
            </ConfirmButton>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function EditChecklist({
  checklist,
  options,
  onSaved,
}: {
  checklist: SavedChecklist;
  options: AppliesToOption[];
  onSaved: () => void;
}) {
  const [state, save] = useActionState<ActionState, FormData>(saveChecklistTemplate, IDLE);
  const keep = useKeepTyped(state);

  useEffect(() => {
    if (state.ok) onSaved();
  }, [state, onSaved]);

  return (
    <form ref={keep} action={save} className="space-y-4">
      <input type="hidden" name="id" value={checklist.id} />
      <FormError>{state.error}</FormError>
      <ChecklistFields
        idPrefix={`checklist-${checklist.id}`}
        defaults={checklist}
        options={options}
        errors={state.fieldErrors}
      />
      <div className="flex items-center justify-end gap-3">
        <ActionStatus state={state} className="mr-auto" />
        <SubmitButton size="sm">Save</SubmitButton>
      </div>
    </form>
  );
}

function AddChecklist({ options }: { options: AppliesToOption[] }) {
  const [state, save] = useActionState<ActionState, FormData>(saveChecklistTemplate, IDLE);
  const keep = useKeepTyped(state);
  const name = useRef<HTMLInputElement>(null);
  const items = useRef<HTMLTextAreaElement>(null);

  // An example fills the fields in, to be changed before it is saved.
  const fillFrom = (example: (typeof CHECKLIST_EXAMPLES)[number]) => {
    if (name.current) name.current.value = example.name;
    if (items.current) items.current.value = example.items.join("\n");
    name.current?.focus();
  };

  return (
    <form ref={keep} action={save} className="space-y-4 border-t border-line px-5 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-2 text-sm font-medium text-ink">Add a checklist</p>
        <span className="text-xs text-ink-subtle">Start from:</span>
        {CHECKLIST_EXAMPLES.map((example) => (
          <Button key={example.name} type="button" variant="outline" size="sm" onClick={() => fillFrom(example)}>
            {example.name}
          </Button>
        ))}
      </div>
      <FormError>{state.error}</FormError>
      <ChecklistFields
        idPrefix="new-checklist"
        defaults={{ name: "", items: [], appliesTo: "" }}
        options={options}
        errors={state.fieldErrors}
        nameRef={name}
        itemsRef={items}
      />
      <div className="flex items-center justify-end gap-3">
        <ActionStatus state={state} className="mr-auto" />
        <SubmitButton pendingLabel="Adding…">
          <Plus className="h-4 w-4" strokeWidth={2} />
          Add checklist
        </SubmitButton>
      </div>
    </form>
  );
}

function ChecklistFields({
  idPrefix,
  defaults,
  options,
  errors,
  nameRef,
  itemsRef,
}: {
  idPrefix: string;
  defaults: { name: string; items: string[]; appliesTo: string };
  options: AppliesToOption[];
  errors?: Record<string, string>;
  nameRef?: React.Ref<HTMLInputElement>;
  itemsRef?: React.Ref<HTMLTextAreaElement>;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${idPrefix}-name`} error={errors?.name} required>
          <Input
            ref={nameRef}
            id={`${idPrefix}-name`}
            name="name"
            defaultValue={defaults.name}
            maxLength={CHECKLIST_NAME_MAX}
            placeholder="e.g. HVAC service visit"
            required
          />
        </Field>
        <Field
          label="Goes on"
          htmlFor={`${idPrefix}-applies`}
          error={errors?.appliesTo}
          hint="Picked from a job's page, or on every new entry in a category."
        >
          <Select id={`${idPrefix}-applies`} name="appliesTo" defaultValue={defaults.appliesTo}>
            <option value="">Only when picked from a job</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                Every new {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label="Items"
        htmlFor={`${idPrefix}-items`}
        error={errors?.items}
        hint={`One per line, in order — up to ${CHECKLIST_MAX_ITEMS}. Bullets and numbers in a pasted list are dropped.`}
        required
      >
        <Textarea
          ref={itemsRef}
          id={`${idPrefix}-items`}
          name="items"
          rows={7}
          defaultValue={defaults.items.join("\n")}
          placeholder={"Before photos taken\nWork done as quoted\nSite cleaned up"}
          // A line can be this long; the whole box allows for every line.
          maxLength={CHECKLIST_MAX_ITEMS * (CHECKLIST_ITEM_MAX + 1)}
        />
      </Field>
    </div>
  );
}

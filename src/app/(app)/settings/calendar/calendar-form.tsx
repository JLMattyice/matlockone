"use client";

import { useActionState, useEffect, useState } from "react";
import { Pencil, Plus } from "lucide-react";

import { deleteJobCategory, saveJobCategory, setBuiltInShown } from "./actions";
import { CategoryMark } from "../../jobs/category-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Checkbox, Field, FormError, Input } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  CATEGORY_ICONS,
  JOB_CATEGORY_NAME_MAX,
  JOB_KIND_ICONS,
  JOB_KIND_META,
  JOB_KINDS,
  MAX_JOB_CATEGORIES,
  type JobKind,
} from "@/lib/constants";
import { asCategoryIcon } from "@/lib/job-categories";
import { cn } from "@/lib/utils";

/**
 * Settings → Calendar: which built-in categories the picker offers, and the
 * business's own.
 */

type OwnCategory = {
  id: string;
  name: string;
  icon: string;
  kind: string;
  entries: number;
};

export function CalendarSettingsForm({
  categories,
  builtInCounts,
  hiddenKinds,
  jobLabel,
  jobPlural,
  readOnly,
}: {
  categories: OwnCategory[];
  builtInCounts: Record<string, number>;
  hiddenKinds: JobKind[];
  jobLabel: string;
  jobPlural: string;
  readOnly: boolean;
}) {
  const full = categories.length >= MAX_JOB_CATEGORIES;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Your categories"
          description="Add your own — a newsletter, a trade show, a photo shoot. Each shows on the calendar with the mark you pick."
        />

        <CardBody className="space-y-3">
          {categories.length === 0 ? (
            <p className="text-sm text-ink-muted">
              None yet.{" "}
              {readOnly
                ? "Ask an owner or admin to add some."
                : "Add one below and it joins the picker on every new entry."}
            </p>
          ) : (
            categories.map((category) => (
              <OwnCategoryRow
                key={category.id}
                category={category}
                jobLabel={jobLabel}
                jobPlural={jobPlural}
                readOnly={readOnly}
              />
            ))
          )}
        </CardBody>

        {readOnly ? null : full ? (
          <CardFooter>
            <p className="mr-auto text-sm text-ink-muted">
              That is the most a business can have ({MAX_JOB_CATEGORIES}).
              Delete one you no longer use to add another.
            </p>
          </CardFooter>
        ) : (
          // Keyed on the count so a successful add starts the next one clean.
          <AddCategory key={categories.length} jobPlural={jobPlural} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Built-in categories"
          description="Turn off the ones your business never uses. They leave the picker; anything already filed under one keeps it."
        />

        <CardBody className="divide-y divide-line p-0">
          {JOB_KINDS.map((kind) => (
            <BuiltInRow
              key={kind}
              kind={kind}
              label={kind === "JOB" ? jobLabel : JOB_KIND_META[kind].label}
              hint={
                kind === "JOB"
                  ? "Billable work at a site. Always on — estimates turn into these."
                  : JOB_KIND_META[kind].hint
              }
              entries={builtInCounts[kind] ?? 0}
              shown={!hiddenKinds.includes(kind)}
              readOnly={readOnly}
            />
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------ built-ins ---

function BuiltInRow({
  kind,
  label,
  hint,
  entries,
  shown,
  readOnly,
}: {
  kind: JobKind;
  label: string;
  hint: string;
  entries: number;
  shown: boolean;
  readOnly: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-3.5">
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          shown ? "bg-brand/10 text-brand" : "bg-surface-3 text-ink-subtle",
        )}
      >
        <CategoryMark icon={JOB_KIND_ICONS[kind]} className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-medium", shown ? "text-ink" : "text-ink-muted")}>
          {label}
        </p>
        <p className="text-xs text-ink-subtle">
          {hint}
          {entries > 0 ? ` · ${entryCount(entries)}` : ""}
        </p>
      </div>

      {kind === "JOB" ? (
        <span className="shrink-0 text-xs text-ink-subtle">Always on</span>
      ) : readOnly ? (
        <span className="shrink-0 text-xs text-ink-subtle">{shown ? "On" : "Off"}</span>
      ) : (
        <form action={setBuiltInShown} className="shrink-0">
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="shown" value={shown ? "false" : "true"} />
          <button
            type="submit"
            role="switch"
            aria-checked={shown}
            aria-label={`${shown ? "Turn off" : "Turn on"}: ${label}`}
            className={cn(
              "relative h-6 w-11 rounded-full transition-colors",
              shown ? "bg-brand" : "bg-surface-3",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all",
                shown ? "left-5.5" : "left-0.5",
              )}
            />
          </button>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------ own categories ---

function OwnCategoryRow({
  category,
  jobLabel,
  jobPlural,
  readOnly,
}: {
  category: OwnCategory;
  jobLabel: string;
  jobPlural: string;
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const countsAsWork = category.kind === "JOB";
  // What its entries read as once it is gone.
  const fallback = countsAsWork ? jobLabel : JOB_KIND_META.OTHER.label;

  return (
    <div
      className={cn(
        "rounded-card border transition-colors",
        editing ? "border-brand/30 bg-brand/4" : "border-line",
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <CategoryMark icon={category.icon} className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            <span className="truncate">{category.name}</span>
            {countsAsWork ? <Badge tone="accent">Counts as work</Badge> : null}
          </p>
          <p className="text-xs text-ink-subtle">
            {category.entries > 0 ? entryCount(category.entries) : "Nothing filed under it yet"}
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
          <EditCategory
            category={category}
            jobPlural={jobPlural}
            onSaved={() => setEditing(false)}
          />

          <form
            action={deleteJobCategory}
            className="flex flex-wrap items-center gap-3 border-t border-line pt-4"
          >
            <input type="hidden" name="id" value={category.id} />
            <p className="mr-auto text-xs text-ink-subtle">
              {category.entries > 0
                ? `Deleting it keeps its ${entryCount(category.entries)}; ${
                    category.entries === 1 ? "it shows" : "they show"
                  } as ${fallback} instead.`
                : "Nothing is filed under it, so deleting it changes nothing else."}
            </p>
            <ConfirmButton
              variant="outline"
              size="sm"
              confirmLabel="Delete it?"
              pendingLabel="Deleting…"
            >
              Delete category
            </ConfirmButton>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function EditCategory({
  category,
  jobPlural,
  onSaved,
}: {
  category: OwnCategory;
  jobPlural: string;
  onSaved: () => void;
}) {
  const [state, save] = useActionState<ActionState, FormData>(saveJobCategory, IDLE);
  const keep = useKeepTyped(state);

  useEffect(() => {
    if (state.ok) onSaved();
  }, [state, onSaved]);

  return (
    <form ref={keep} action={save} className="space-y-4">
      <input type="hidden" name="id" value={category.id} />
      <FormError>{state.error}</FormError>
      <CategoryFields
        idPrefix={`category-${category.id}`}
        defaults={{
          name: category.name,
          icon: asCategoryIcon(category.icon),
          countsAsWork: category.kind === "JOB",
        }}
        errors={state.fieldErrors}
        jobPlural={jobPlural}
      />
      <div className="flex items-center justify-end gap-3">
        <ActionStatus state={state} className="mr-auto" />
        <SubmitButton size="sm">Save</SubmitButton>
      </div>
    </form>
  );
}

function AddCategory({ jobPlural }: { jobPlural: string }) {
  const [state, save] = useActionState<ActionState, FormData>(saveJobCategory, IDLE);
  const keep = useKeepTyped(state);

  return (
    <form ref={keep} action={save} className="space-y-4 border-t border-line px-5 py-5">
      <p className="text-sm font-medium text-ink">Add a category</p>
      <FormError>{state.error}</FormError>
      <CategoryFields
        idPrefix="new-category"
        defaults={{ name: "", icon: "tag", countsAsWork: false }}
        errors={state.fieldErrors}
        jobPlural={jobPlural}
      />
      <div className="flex items-center justify-end gap-3">
        <ActionStatus state={state} className="mr-auto" />
        <SubmitButton pendingLabel="Adding…">
          <Plus className="h-4 w-4" strokeWidth={2} />
          Add category
        </SubmitButton>
      </div>
    </form>
  );
}

/**
 * Name, mark and whether it is work. The mark is a row of radios styled off
 * their own checked state, so the browser's form reset and useKeepTyped look
 * after it with nothing held in React.
 */
function CategoryFields({
  idPrefix,
  defaults,
  errors,
  jobPlural,
}: {
  idPrefix: string;
  defaults: { name: string; icon: string; countsAsWork: boolean };
  errors?: Record<string, string>;
  jobPlural: string;
}) {
  return (
    <>
      <Field label="Name" htmlFor={`${idPrefix}-name`} required error={errors?.name}>
        <Input
          id={`${idPrefix}-name`}
          name="name"
          defaultValue={defaults.name}
          maxLength={JOB_CATEGORY_NAME_MAX}
          required
          placeholder="Newsletter"
        />
      </Field>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-ink">Mark</legend>
        <div className="flex flex-wrap gap-1.5">
          {CATEGORY_ICONS.map((icon) => (
            <label
              key={icon}
              title={icon.replace(/-/g, " ")}
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-line text-ink-muted transition-colors hover:border-line-strong has-checked:border-brand has-checked:bg-brand/10 has-checked:text-brand has-focus-visible:ring-2 has-focus-visible:ring-brand/40"
            >
              <input
                type="radio"
                name="icon"
                value={icon}
                defaultChecked={icon === defaults.icon}
                className="sr-only"
                aria-label={icon.replace(/-/g, " ")}
              />
              <CategoryMark icon={icon} className="h-4 w-4" />
            </label>
          ))}
        </div>
        {errors?.icon ? <p className="mt-1.5 text-xs text-danger">{errors.icon}</p> : null}
      </fieldset>

      <label className="flex items-start gap-2.5 text-sm text-ink">
        <Checkbox
          name="countsAsWork"
          defaultChecked={defaults.countsAsWork}
          className="mt-0.5"
        />
        <span>
          Counts as client work
          <span className="block text-xs text-ink-subtle">
            Finished entries count toward {jobPlural.toLowerCase()} completed on the
            dashboard and in reports. Leave off for things like posts and
            deadlines.
          </span>
        </span>
      </label>
    </>
  );
}

function entryCount(count: number) {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

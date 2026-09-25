"use client";

import { useActionState } from "react";

import {
  runWorkflowSweep,
  setWorkflowActive,
  updateWorkflowSettings,
} from "./actions";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import type { WorkflowConfig, WorkflowTemplate } from "@/lib/workflows/templates";
import { cn } from "@/lib/utils";

/**
 * The automations screen.
 *
 * Each automation is a sentence, a switch and — when it is on — the one or two
 * numbers it runs on. Nothing here composes conditions: the argument for that
 * is in the templates module.
 */

export type AutomationRow = {
  template: WorkflowTemplate;
  isActive: boolean;
  config: WorkflowConfig;
  scheduled: boolean;
  lastRunAt: string | null;
};

export function AutomationsForm({
  automations,
  raised,
  automatic,
  readOnly,
}: {
  automations: AutomationRow[];
  raised: number;
  /** Whether this deployment runs the date-based check every morning itself. */
  automatic: boolean;
  readOnly: boolean;
}) {
  const [sweepState, runSweep] = useActionState<ActionState, FormData>(
    runWorkflowSweep,
    IDLE,
  );

  const anyScheduledOn = automations.some((row) => row.scheduled && row.isActive);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Automations"
          description="Things Matlock One does by itself. Each one raises a task — nothing here emails a customer on your behalf."
        />

        <CardBody className="space-y-4">
          {automations.map((row) => (
            <Automation key={row.template.id} row={row} readOnly={readOnly} />
          ))}
        </CardBody>
      </Card>

      {/* The sweep. Only worth showing once something depends on it. */}
      {anyScheduledOn ? (
        <Card>
          <CardHeader
            title="Check now"
            description={
              // Says which is true here. On the hosted app the check runs each
              // morning; on a desktop install nothing wakes up by itself, and
              // claiming otherwise would leave overdue invoices unchased.
              automatic
                ? "Two of these wait for a date to pass rather than for something to happen. They are checked every morning by themselves; this runs the same check now."
                : "Two of these wait for a date to pass rather than for something to happen. Nothing in Matlock One wakes up on its own, so this is where that check runs."
            }
          />

          <CardBody>
            <p className="text-sm text-ink-muted">
              Safe to press as often as you like: each automation raises one
              task per invoice or customer, however many times it runs.
            </p>
            {raised > 0 ? (
              <p className="mt-2 text-sm text-ink-subtle">
                {raised} {raised === 1 ? "task has" : "tasks have"} been raised
                automatically so far.
              </p>
            ) : null}
          </CardBody>

          {readOnly ? null : (
            <CardFooter>
              <ActionStatus state={sweepState} className="mr-auto" />
              <form action={runSweep}>
                <SubmitButton pendingLabel="Checking…">Check now</SubmitButton>
              </form>
            </CardFooter>
          )}
        </Card>
      ) : null}
    </div>
  );
}

function Automation({ row, readOnly }: { row: AutomationRow; readOnly: boolean }) {
  const [state, save] = useActionState<ActionState, FormData>(
    updateWorkflowSettings,
    IDLE,
  );

  const { template } = row;

  return (
    <div
      className={cn(
        "rounded-card border p-4 transition-colors",
        row.isActive ? "border-brand/30 bg-brand/4" : "border-line bg-surface-2",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{template.name}</p>
          <p className="mt-1 text-sm text-ink-muted">{template.description}</p>
          {row.scheduled && row.lastRunAt ? (
            <p className="mt-2 text-xs text-ink-subtle">
              Last checked {new Date(row.lastRunAt).toLocaleString()}
            </p>
          ) : null}
        </div>

        {readOnly ? (
          <span className="shrink-0 text-xs text-ink-subtle">
            {row.isActive ? "On" : "Off"}
          </span>
        ) : (
          <form action={setWorkflowActive} className="shrink-0">
            <input type="hidden" name="templateId" value={template.id} />
            <input
              type="hidden"
              name="isActive"
              value={row.isActive ? "false" : "true"}
            />
            <button
              type="submit"
              role="switch"
              aria-checked={row.isActive}
              aria-label={`${row.isActive ? "Turn off" : "Turn on"}: ${template.name}`}
              className={cn(
                "relative h-6 w-11 rounded-full transition-colors",
                row.isActive ? "bg-brand" : "bg-surface-3",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all",
                  row.isActive ? "left-5.5" : "left-0.5",
                )}
              />
            </button>
          </form>
        )}
      </div>

      {/* The numbers only matter once it is running. */}
      {row.isActive && !readOnly ? (
        <form action={save} className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="templateId" value={template.id} />

          {template.settings.map((setting) => (
            <Field
              key={setting.key}
              label={setting.label}
              htmlFor={`${template.id}-${setting.key}`}
              hint={setting.hint}
              className="w-44"
            >
              <Input
                id={`${template.id}-${setting.key}`}
                name={setting.key}
                type="number"
                min={setting.min}
                max={setting.max}
                defaultValue={row.config[setting.key]}
                className="tabular"
              />
            </Field>
          ))}

          {/* Every template has dueInDays; days is absent on the event ones,
              and the action reads whatever is missing as the default. */}
          <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          <ActionStatus state={state} />
        </form>
      ) : null}
    </div>
  );
}

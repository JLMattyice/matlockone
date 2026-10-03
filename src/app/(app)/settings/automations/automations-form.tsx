"use client";

import { useActionState } from "react";

import {
  runWorkflowSweep,
  saveReviewUrl,
  setWorkflowActive,
  updateWorkflowSettings,
} from "./actions";
import { Badge } from "@/components/ui/badge";
import { useTimeZone } from "@/components/app-shell/time-zone";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { IDLE, type ActionState } from "@/lib/action-state";
import { formatIn } from "@/lib/time-zone";
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
  reviewUrl,
  emailConnected,
}: {
  automations: AutomationRow[];
  raised: number;
  /** Where the review request sends customers; that automation waits for it. */
  reviewUrl: string | null;
  /** Whether a mail account is connected to send the customer emails through. */
  emailConnected: boolean;
  /** Whether this deployment runs the date-based check every morning itself. */
  /** When the date-based check runs by itself here, if it does. */
  automatic: "daily" | "while-open" | null;
  readOnly: boolean;
}) {
  const [sweepState, runSweep] = useActionState<ActionState, FormData>(
    runWorkflowSweep,
    IDLE,
  );

  const anyScheduledOn = automations.some((row) => row.scheduled && row.isActive);
  const anyEmailOn = automations.some((row) => row.template.action === "EMAIL" && row.isActive);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Automations"
          description="Things Matlock One does by itself. Most raise a task for you; the ones marked “Emails the customer” write to your customer instead, through your own email account. All start off."
        />

        <CardBody className="space-y-4">
          {anyEmailOn && !emailConnected ? (
            <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
              No email account is connected, so customer emails wait in the outbox. Connect one
              under Settings → Email and they go out.
            </p>
          ) : null}
          {automations.map((row) => (
            <Automation key={row.template.id} row={row} readOnly={readOnly} reviewUrl={reviewUrl} />
          ))}
        </CardBody>
      </Card>

      {/* The sweep. Only worth showing once something depends on it. */}
      {anyScheduledOn ? (
        <Card>
          <CardHeader
            title="Check now"
            description={
              // Says which is true here: every morning on the hosted app,
              // every few hours while a desktop install is open, or only when
              // somebody presses this. Claiming a schedule that is not there
              // would leave overdue invoices unchased.
              automatic === "daily"
                ? "Some of these wait for a date to pass rather than for something to happen. They are checked every morning by themselves; this runs the same check now."
                : automatic === "while-open"
                  ? "Some of these wait for a date to pass rather than for something to happen. They are checked by themselves every few hours while Matlock One is open on this computer; this runs the same check now."
                  : "Some of these wait for a date to pass rather than for something to happen. Nothing in Matlock One wakes up on its own, so this is where that check runs."
            }
          />

          <CardBody>
            <p className="text-sm text-ink-muted">
              Safe to press as often as you like: each automation acts once per
              invoice, estimate, visit or customer, however many times it runs.
            </p>
            {raised > 0 ? (
              <p className="mt-2 text-sm text-ink-subtle">
                {raised} {raised === 1 ? "task or email has" : "tasks and emails have"} gone out
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

function Automation({
  row,
  readOnly,
  reviewUrl,
}: {
  row: AutomationRow;
  readOnly: boolean;
  reviewUrl: string | null;
}) {
  const zone = useTimeZone();
  const [state, save] = useActionState<ActionState, FormData>(
    updateWorkflowSettings,
    IDLE,
  );

  // React clears the form when the save returns; this puts the typing
  // back when the answer was a refusal.
  const keep = useKeepTyped(state);

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
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            {template.name}
            {template.action === "EMAIL" ? <Badge tone="info">Emails the customer</Badge> : null}
          </p>
          <p className="mt-1 text-sm text-ink-muted">{template.description}</p>
          {row.scheduled && row.lastRunAt ? (
            <p className="mt-2 text-xs text-ink-subtle">
              Last checked {formatIn(row.lastRunAt, "MMM d, yyyy 'at' h:mm a", zone)}
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
        <form ref={keep} action={save} className="mt-4 flex flex-wrap items-end gap-3">
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

      {template.id === "review.request.email" && row.isActive ? (
        <ReviewLink reviewUrl={reviewUrl} readOnly={readOnly} />
      ) : null}
    </div>
  );
}

/** The review page the request sends customers to; nothing goes until it is set. */
function ReviewLink({ reviewUrl, readOnly }: { reviewUrl: string | null; readOnly: boolean }) {
  const [state, save] = useActionState<ActionState, FormData>(saveReviewUrl, IDLE);
  const keep = useKeepTyped(state);

  return (
    <form ref={keep} action={save} className="mt-4 space-y-2">
      <Field
        label="Your review link"
        htmlFor="reviewUrl"
        error={state.fieldErrors?.reviewUrl}
        hint={
          reviewUrl
            ? "Where customers are sent to leave a review: your Google, Yelp or Facebook review page."
            : "Nothing is sent until this is set. In your Google Business Profile it is under Ask for reviews."
        }
      >
        <Input
          id="reviewUrl"
          name="reviewUrl"
          type="url"
          defaultValue={reviewUrl ?? ""}
          placeholder="https://g.page/r/…/review"
          disabled={readOnly}
        />
      </Field>
      {readOnly ? null : (
        <div className="flex items-center gap-3">
          <SubmitButton pendingLabel="Saving…">Save link</SubmitButton>
          <ActionStatus state={state} />
        </div>
      )}
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";
import { Check, Copy, Send } from "lucide-react";

import { convertEstimateToJob, sendEstimate } from "../actions";
import { Button, buttonClasses } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

/** Send, with a chance to correct the address before it goes out. */
export function SendEstimate({
  estimateId,
  defaultEmail,
  alreadySent,
}: {
  estimateId: string;
  defaultEmail: string | null;
  alreadySent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<ActionState, FormData>(
    sendEstimate,
    IDLE,
  );

  if (!open && !state.ok) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses(alreadySent ? "outline" : "primary", "md")}
      >
        <Send className="h-3.5 w-3.5" strokeWidth={2} />
        {alreadySent ? "Send again" : "Send"}
      </button>
    );
  }

  if (state.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-success">
        <Check className="h-4 w-4" strokeWidth={2} />
        {state.message}
      </span>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={estimateId} />

      <Field label="Send to" htmlFor="email" error={state.fieldErrors?.email}>
        <Input
          id="email"
          name="email"
          type="email"
          defaultValue={defaultEmail ?? ""}
          placeholder="client@example.com"
          className="w-64"
          autoFocus
        />
      </Field>

      <SubmitButton pendingLabel="Sending…">Send estimate</SubmitButton>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className={buttonClasses("ghost", "md")}
      >
        Cancel
      </button>

      <ActionStatus state={state} className="w-full" />
    </form>
  );
}

/** Convert to a job, optionally booking it straight onto the calendar. */
export function ConvertToJob({
  estimateId,
  jobLabel,
}: {
  estimateId: string;
  jobLabel: string;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses("primary", "md")}
      >
        Convert to {jobLabel.toLowerCase()}
      </button>
    );
  }

  return (
    <form
      action={convertEstimateToJob}
      className="flex flex-wrap items-end gap-2"
    >
      <input type="hidden" name="id" value={estimateId} />

      <Field
        label="Schedule for"
        htmlFor="scheduledStart"
        hint="Leave blank to place it in the unscheduled list."
      >
        <Input
          id="scheduledStart"
          name="scheduledStart"
          type="datetime-local"
          className="w-56"
          autoFocus
        />
      </Field>

      <Field label="Duration" htmlFor="durationMinutes">
        <Select
          id="durationMinutes"
          name="durationMinutes"
          defaultValue="120"
          className="w-32"
        >
          {[60, 90, 120, 180, 240, 300, 480].map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes < 60 ? `${minutes} min` : `${minutes / 60} hours`}
            </option>
          ))}
        </Select>
      </Field>

      <Button type="submit">Create {jobLabel.toLowerCase()}</Button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className={buttonClasses("ghost", "md")}
      >
        Cancel
      </button>
    </form>
  );
}

/** The client-facing link, copyable for pasting into a text or email. */
export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the input beside it is selectable instead.
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Client link"
        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 font-mono text-xs text-ink-muted"
      />
      <button
        type="button"
        onClick={copy}
        className={buttonClasses("outline", "sm")}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" strokeWidth={2} />
        ) : (
          <Copy className="h-3.5 w-3.5" strokeWidth={2} />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

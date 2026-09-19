"use client";

import { useRef } from "react";

import { setLeadStatus } from "./actions";
import { LEAD_STATUSES, leadStatusLabel } from "@/lib/constants";
import { cn } from "@/lib/utils";

/**
 * Moves a lead through the pipeline in one interaction. Submitting the form on
 * change means no separate save button on every card — and because it is a
 * real form posting a server action, it still works before hydration.
 */
export function LeadStatusSelect({
  leadId,
  status,
  estimateSingular,
  className,
}: {
  leadId: string;
  status: string;
  /** The word this workspace uses for an estimate, for the one stage named after it. */
  estimateSingular: string;
  className?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form ref={formRef} action={setLeadStatus} className="contents">
      <input type="hidden" name="id" value={leadId} />
      <select
        name="status"
        defaultValue={status}
        aria-label="Lead status"
        onChange={() => formRef.current?.requestSubmit()}
        className={cn(
          "h-7 cursor-pointer rounded-md border border-line bg-surface px-2 text-xs text-ink-muted transition-colors hover:border-line-strong",
          className,
        )}
      >
        {LEAD_STATUSES.map((option) => (
          <option key={option} value={option}>
            {leadStatusLabel(option, estimateSingular)}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="text-xs underline">
          Move
        </button>
      </noscript>
    </form>
  );
}

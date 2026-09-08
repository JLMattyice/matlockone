"use client";

import { useActionState } from "react";
import { BellRing } from "lucide-react";

import { sendInvoiceReminders } from "./reminders";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

/**
 * Chases everything due or overdue in one go. Written as an action with no
 * request-specific state, so a scheduled task can call the same code later.
 */
export function SendReminders({ candidates }: { candidates: number }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    sendInvoiceReminders,
    IDLE,
  );

  if (candidates === 0 && !state.message) return null;

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <SubmitButton
        variant="outline"
        size="md"
        pendingLabel="Sending…"
        disabled={candidates === 0}
      >
        <BellRing className="h-3.5 w-3.5" strokeWidth={2} />
        Chase {candidates} unpaid
      </SubmitButton>
      <ActionStatus state={state} />
    </form>
  );
}

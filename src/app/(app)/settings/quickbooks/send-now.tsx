"use client";

import { useActionState } from "react";

import { sendToQuickBooksNow } from "./actions";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

export function SendNow() {
  const [state, action] = useActionState<ActionState, FormData>(sendToQuickBooksNow, IDLE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <SubmitButton pendingLabel="Sending…">Send now</SubmitButton>
      <ActionStatus state={state} />
    </form>
  );
}

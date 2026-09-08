"use client";

import { useFormStatus } from "react-dom";

import { Button, type ButtonProps } from "./button";
import type { ActionState } from "@/lib/action-state";
import { cn } from "@/lib/utils";

export function SubmitButton({
  children = "Save changes",
  pendingLabel = "Saving…",
  ...props
}: ButtonProps & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

/** Inline confirmation or error shown next to a form's save button. */
export function ActionStatus({
  state,
  className,
}: {
  state: ActionState;
  className?: string;
}) {
  if (!state.message && !state.error) return null;

  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "text-sm",
        state.ok ? "text-success" : "text-danger",
        className,
      )}
    >
      {state.error ?? state.message}
    </p>
  );
}

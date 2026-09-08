"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button, type ButtonProps } from "./button";

/**
 * Two-step confirmation for a destructive submit: the first click arms the
 * button, the second one submits. Avoids a modal for what is a single decision,
 * and disarms itself after a few seconds so it cannot be triggered by a stray
 * click much later.
 */
export function ConfirmButton({
  children,
  confirmLabel = "Are you sure?",
  pendingLabel = "Working…",
  variant = "danger",
  size = "md",
  ...props
}: ButtonProps & { confirmLabel?: string; pendingLabel?: string }) {
  const { pending } = useFormStatus();
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function arm(event: React.MouseEvent<HTMLButtonElement>) {
    if (armed) return; // let the submit through
    event.preventDefault();
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), 4000);
  }

  return (
    <Button
      {...props}
      type="submit"
      variant={armed ? "danger" : variant}
      size={size}
      disabled={pending}
      onClick={arm}
    >
      {pending ? pendingLabel : armed ? confirmLabel : children}
    </Button>
  );
}

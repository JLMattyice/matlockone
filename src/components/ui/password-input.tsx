"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "./form";
import { cn } from "@/lib/utils";

/**
 * A password field you can look at.
 *
 * Typing a password you cannot see is how people end up locked out of their own
 * software — a capital letter that did not register, a trailing space, a
 * password manager that filled the wrong field. Every password box in the app
 * uses this so that is always recoverable in the moment.
 *
 * The toggle is a button rather than a checkbox so it never gets submitted with
 * the form, and it is excluded from tab order: someone tabbing from the field
 * expects to reach the submit button, not a control they did not ask for.
 */
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">
>(function PasswordInput({ className, ...props }, ref) {
  const [visible, setVisible] = React.useState(false);

  const Icon = visible ? EyeOff : Eye;
  const label = visible ? "Hide password" : "Show password";

  return (
    <div className="relative">
      <Input
        ref={ref}
        type={visible ? "text" : "password"}
        // Room for the button, so a long password never runs underneath it.
        className={cn("pr-10", className)}
        {...props}
      />

      <button
        type="button"
        onClick={() => setVisible((shown) => !shown)}
        // Not a toggle for assistive tech to announce as pressed/unpressed —
        // the label already says what the next click does.
        aria-label={label}
        title={label}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-ink-subtle transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none"
      >
        <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
});

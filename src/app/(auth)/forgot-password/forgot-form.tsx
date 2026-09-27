"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { requestPasswordResetAction, type AuthFormState } from "../actions";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full justify-center" disabled={pending}>
      {pending ? "Sending…" : "Email me a link"}
    </Button>
  );
}

export function ForgotForm({ defaultEmail = "" }: { defaultEmail?: string }) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(
    requestPasswordResetAction,
    {},
  );

  // The same words whether or not the address has an account: this screen
  // must not be a way to find out who does.
  if (state.done) {
    return (
      <div className="space-y-3 rounded-lg border border-line bg-surface-2 p-4 text-sm" role="status">
        <p className="font-medium text-ink">Check your email</p>
        <p className="text-ink-muted">
          If an account uses <span className="font-medium text-ink">{state.values?.email}</span>,
          a link to reset its password is on its way. It works for the next hour.
        </p>
        <p className="text-ink-muted">
          Nothing after a few minutes? Check your spam folder, or{" "}
          <a href="/forgot-password" className="font-medium text-brand hover:underline">
            ask again
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <FormError>{state.error}</FormError>

      <Field label="Email" htmlFor="email" required error={state.fieldErrors?.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          defaultValue={state.values?.email ?? defaultEmail}
          required
          placeholder="you@business.com"
          aria-invalid={Boolean(state.fieldErrors?.email)}
        />
      </Field>

      <SubmitButton />
    </form>
  );
}

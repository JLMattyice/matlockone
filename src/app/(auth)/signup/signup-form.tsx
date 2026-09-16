"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { signupAction, type AuthFormState } from "../actions";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Field, FormError, Input } from "@/components/ui/form";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full justify-center" disabled={pending}>
      {pending ? "Creating workspace…" : "Create workspace"}
    </Button>
  );
}

/**
 * `offerSignIn` is false on a brand-new installation. There is no account to
 * sign in to yet, and /login sends a first run straight back here, so the link
 * could only reload the page it sits on — which reads as a sign-in button that
 * does nothing.
 */
export function SignupForm({ offerSignIn }: { offerSignIn: boolean }) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(
    signupAction,
    {},
  );

  // The defaultValue on each field below is what survives a rejected
  // submission. React resets the form once the action returns, and a reset
  // restores inputs to their defaults — so the defaults have to be the values
  // that came back, or the whole form empties itself and the error message is
  // left explaining a field nobody can still see they filled in.

  return (
    <form action={formAction} className="space-y-4">
      <FormError>{state.error}</FormError>

      <Field
        label="Business name"
        htmlFor="businessName"
        required
        error={state.fieldErrors?.businessName}
        hint="Shown on estimates and invoices. You can change it later."
      >
        <Input
          id="businessName"
          name="businessName"
          autoFocus
          defaultValue={state.values?.businessName ?? ""}
          required
          placeholder="Northside Services"
          aria-invalid={Boolean(state.fieldErrors?.businessName)}
        />
      </Field>

      <Field label="Your name" htmlFor="name" required error={state.fieldErrors?.name}>
        <Input
          id="name"
          name="name"
          autoComplete="name"
          defaultValue={state.values?.name ?? ""}
          required
          placeholder="Alex Rivera"
          aria-invalid={Boolean(state.fieldErrors?.name)}
        />
      </Field>

      <Field label="Email" htmlFor="email" required error={state.fieldErrors?.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          defaultValue={state.values?.email ?? ""}
          required
          placeholder="you@business.com"
          aria-invalid={Boolean(state.fieldErrors?.email)}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        required
        error={state.fieldErrors?.password}
        hint="At least 8 characters, including a letter and a number."
      >
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          required
          aria-invalid={Boolean(state.fieldErrors?.password)}
        />
      </Field>

      <SubmitButton />

      {offerSignIn ? (
        <p className="pt-1 text-center text-sm text-ink-muted">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-brand hover:underline">
            Sign in
          </Link>
        </p>
      ) : null}
    </form>
  );
}

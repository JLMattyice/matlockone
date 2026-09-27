"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { resetPasswordAction, type AuthFormState } from "../../actions";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { PasswordInput } from "@/components/ui/password-input";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full justify-center" disabled={pending}>
      {pending ? "Saving…" : "Save and sign in"}
    </Button>
  );
}

export function ResetForm({ token, email }: { token: string; email: string }) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(resetPasswordAction, {});

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      {/* For password managers, so the new password is saved against the
          right account. Not a field anybody edits. */}
      <input
        type="email"
        name="username"
        autoComplete="username"
        value={email}
        readOnly
        tabIndex={-1}
        aria-hidden
        className="sr-only"
      />

      {state.error ? (
        <FormError>
          {state.error}{" "}
          <Link href="/forgot-password" className="font-medium underline">
            Send a new link
          </Link>
        </FormError>
      ) : null}

      <Field
        label="New password"
        htmlFor="password"
        required
        hint="At least 8 characters, with a letter and a number."
        error={state.fieldErrors?.password}
      >
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          autoFocus
          required
          aria-invalid={Boolean(state.fieldErrors?.password)}
        />
      </Field>

      <Field label="Type it again" htmlFor="confirm" required error={state.fieldErrors?.confirm}>
        <PasswordInput
          id="confirm"
          name="confirm"
          autoComplete="new-password"
          required
          aria-invalid={Boolean(state.fieldErrors?.confirm)}
        />
      </Field>

      <SubmitButton />
    </form>
  );
}

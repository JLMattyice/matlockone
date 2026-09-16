"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { loginAction, type AuthFormState } from "../actions";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Checkbox, Field, FormError, Input } from "@/components/ui/form";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full justify-center" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </Button>
  );
}

export function LoginForm({
  next,
  rememberedEmail = "",
  offerSignup = true,
}: {
  next?: string;
  rememberedEmail?: string;
  /** False where sign-ups are shut, so the link cannot lead to a closed door. */
  offerSignup?: boolean;
}) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(
    loginAction,
    {},
  );

  // Coming back to a machine that already knows you, the only thing left to
  // type is the password — so that is where the cursor goes.
  const known = rememberedEmail.length > 0;

  // A rejected sign-in comes back carrying the address that was typed, and it
  // wins over the remembered one. React resets the form when the action
  // returns, so without this a wrong password also silently swaps the address
  // in the box for a different account's.
  const emailValue = state.values?.email ?? rememberedEmail;

  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <FormError>{state.error}</FormError>

      <Field
        label="Email"
        htmlFor="email"
        required
        error={state.fieldErrors?.email}
      >
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus={!known}
          defaultValue={emailValue}
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
      >
        <PasswordInput
          id="password"
          name="password"
          autoComplete="current-password"
          autoFocus={known}
          required
          placeholder="••••••••"
          aria-invalid={Boolean(state.fieldErrors?.password)}
        />
      </Field>

      <label
        htmlFor="remember"
        className="flex cursor-pointer items-center gap-2 text-sm text-ink-muted"
      >
        <Checkbox id="remember" name="remember" defaultChecked />
        Keep me signed in on this computer
      </label>

      <SubmitButton />

      {offerSignup ? (
        <p className="pt-1 text-center text-sm text-ink-muted">
          New business?{" "}
          <Link href="/signup" className="font-medium text-brand hover:underline">
            Create an account
          </Link>
        </p>
      ) : null}
    </form>
  );
}

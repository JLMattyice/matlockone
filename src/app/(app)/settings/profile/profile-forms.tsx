"use client";

import { useActionState } from "react";

import { changeOwnPassword, updateOwnProfile } from "../actions";
import { Badge } from "@/components/ui/badge";
import { PasswordInput } from "@/components/ui/password-input";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { ROLE_META, type Role } from "@/lib/constants";

export function ProfileForm({
  values,
}: {
  values: {
    name: string;
    email: string;
    phone: string | null;
    position: string | null;
    role: Role;
  };
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateOwnProfile,
    IDLE,
  );

  const err = (key: string) => state.fieldErrors?.[key];
  const meta = ROLE_META[values.role];

  return (
    <form action={formAction}>
      <Card>
        <CardHeader
          title="Your profile"
          description="How your name appears on jobs, notes and documents."
          action={<Badge tone={meta.tone}>{meta.label}</Badge>}
        />

        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="name" required error={err("name")}>
              <Input id="name" name="name" defaultValue={values.name} required />
            </Field>

            <Field label="Email" htmlFor="email" required error={err("email")}>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                defaultValue={values.email}
                required
              />
            </Field>

            <Field label="Phone" htmlFor="phone" error={err("phone")}>
              <Input
                id="phone"
                name="phone"
                type="tel"
                defaultValue={values.phone ?? ""}
              />
            </Field>

            <Field
              label="Position"
              htmlFor="position"
              hint="Job title shown to your team."
            >
              <Input
                id="position"
                name="position"
                defaultValue={values.position ?? ""}
                placeholder="Lead technician"
              />
            </Field>
          </div>

          <p className="text-xs text-ink-subtle">
            {meta.description} Only an owner or administrator can change your role.
          </p>
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <SubmitButton />
        </CardFooter>
      </Card>
    </form>
  );
}

export function PasswordForm() {
  const [state, formAction] = useActionState<ActionState, FormData>(
    changeOwnPassword,
    IDLE,
  );

  const err = (key: string) => state.fieldErrors?.[key];

  return (
    <form action={formAction}>
      <Card>
        <CardHeader
          title="Password"
          description="Changing it signs you out everywhere else."
        />

        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Current password"
            htmlFor="currentPassword"
            required
            error={err("currentPassword")}
            className="sm:col-span-2"
          >
            <PasswordInput
              id="currentPassword"
              name="currentPassword"
              autoComplete="current-password"
              required
            />
          </Field>

          <Field
            label="New password"
            htmlFor="newPassword"
            required
            error={err("newPassword")}
            hint="At least 8 characters, with a letter and a number."
          >
            <PasswordInput
              id="newPassword"
              name="newPassword"
              autoComplete="new-password"
              required
            />
          </Field>

          <Field
            label="Confirm new password"
            htmlFor="confirmPassword"
            required
            error={err("confirmPassword")}
          >
            <PasswordInput
              id="confirmPassword"
              name="confirmPassword"
              autoComplete="new-password"
              required
            />
          </Field>
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <SubmitButton>Change password</SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

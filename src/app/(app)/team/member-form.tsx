"use client";

import Link from "next/link";
import { useActionState } from "react";

import { createTeamMember, updateTeamMember } from "./actions";
import { buttonClasses } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { ROLE_META, type Role } from "@/lib/constants";

export type MemberFormValues = {
  id?: string;
  name: string;
  email: string;
  phone: string;
  position: string;
  role: Role;
  hourlyRate: string;
};

export function MemberForm({
  values,
  assignableRoles,
  currencySymbol,
  lockRole,
  lockReason,
}: {
  values: MemberFormValues;
  assignableRoles: Role[];
  currencySymbol: string;
  /** True when the actor may not change this person's role. */
  lockRole?: boolean;
  lockReason?: string;
}) {
  const isEdit = Boolean(values.id);
  const [state, formAction] = useActionState<ActionState, FormData>(
    isEdit ? updateTeamMember : createTeamMember,
    IDLE,
  );

  const err = (key: string) => state.fieldErrors?.[key];

  // Their current role stays selectable even if the actor could not grant it,
  // so saving other fields does not silently demote them.
  const roleOptions = assignableRoles.includes(values.role)
    ? assignableRoles
    : [values.role, ...assignableRoles];

  return (
    <form action={formAction}>
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      {lockRole ? <input type="hidden" name="role" value={values.role} /> : null}

      <Card>
        <CardHeader
          title={isEdit ? "Team member" : "New team member"}
          description="Their details, what they do, and what they can see."
        />

        <CardBody className="space-y-5">
          <FormError>{state.error}</FormError>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="name" required error={err("name")}>
              <Input
                id="name"
                name="name"
                defaultValue={values.name}
                required
                autoFocus={!isEdit}
              />
            </Field>

            <Field
              label="Email"
              htmlFor="email"
              required
              error={err("email")}
              hint="They sign in with this."
            >
              <Input
                id="email"
                name="email"
                type="email"
                defaultValue={values.email}
                required
              />
            </Field>

            <Field label="Phone" htmlFor="phone">
              <Input
                id="phone"
                name="phone"
                type="tel"
                defaultValue={values.phone}
              />
            </Field>

            <Field label="Position" htmlFor="position" hint="Shown on the team list.">
              <Input
                id="position"
                name="position"
                defaultValue={values.position}
                placeholder="Lead technician"
              />
            </Field>

            <Field
              label="Hourly rate"
              htmlFor="hourlyRate"
              hint="Used to cost logged labor. Leave blank if not applicable."
            >
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-subtle">
                  {currencySymbol}
                </span>
                <Input
                  id="hourlyRate"
                  name="hourlyRate"
                  inputMode="decimal"
                  defaultValue={values.hourlyRate}
                  placeholder="38.00"
                  className="tabular pl-7"
                />
              </div>
            </Field>

            <Field
              label="Role"
              htmlFor="role"
              error={err("role")}
              hint={lockRole ? lockReason : ROLE_META[values.role].description}
            >
              <Select
                id="role"
                name={lockRole ? "roleDisplay" : "role"}
                defaultValue={values.role}
                disabled={lockRole}
              >
                {roleOptions.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_META[role].label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {!isEdit ? (
            <Field
              label="Temporary password"
              htmlFor="password"
              required
              error={err("password")}
              hint="Share it with them; they can change it from their profile."
            >
              <PasswordInput
                id="password"
                name="password"
                autoComplete="new-password"
                required
              />
            </Field>
          ) : null}
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <Link
          href={values.id ? `/team/${values.id}` : "/team"}
          className={buttonClasses("ghost", "md")}
          >
            Cancel
          </Link>
          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Creating…"}>
            {isEdit ? "Save changes" : "Add to team"}
          </SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

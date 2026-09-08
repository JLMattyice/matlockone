"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { createGroup, updateGroup } from "./actions";
import { Avatar } from "@/components/ui/avatar";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { cn } from "@/lib/utils";

export type GroupFormMember = {
  id: string;
  name: string;
  position: string | null;
  isActive: boolean;
};

export type GroupFormValues = {
  id?: string;
  name: string;
  description: string;
  leadId: string;
  memberIds: string[];
};

export function GroupForm({
  values,
  people,
}: {
  values: GroupFormValues;
  people: GroupFormMember[];
}) {
  const isEdit = Boolean(values.id);
  const [state, formAction] = useActionState<ActionState, FormData>(
    isEdit ? updateGroup : createGroup,
    IDLE,
  );

  const [members, setMembers] = useState<string[]>(values.memberIds);
  const [leadId, setLeadId] = useState(values.leadId);

  const err = (key: string) => state.fieldErrors?.[key];

  function toggle(id: string) {
    setMembers((current) => {
      const next = current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id];

      // Somebody who has just been taken out of the group cannot still lead it.
      if (id === leadId && !next.includes(id)) setLeadId("");

      return next;
    });
  }

  // Only members can lead, so the choice narrows as the group is built. That
  // also matches what the action enforces server-side.
  const leadOptions = people.filter((person) => members.includes(person.id));

  return (
    <form action={formAction} className="space-y-6">
      {values.id ? (
        <input type="hidden" name="groupId" value={values.id} />
      ) : null}
      {members.map((id) => (
        <input key={id} type="hidden" name="memberIds" value={id} />
      ))}

      <Card>
        <CardHeader
          title={isEdit ? "Group" : "New group"}
          description="A standing set of people you schedule and report on together."
        />

        <CardBody className="space-y-5">
          <FormError>{state.error}</FormError>

          <Field
            label="Name"
            htmlFor="name"
            required
            hint="What you would call them out loud — Northside, Service, Front office."
            error={err("name")}
          >
            <Input
              id="name"
              name="name"
              defaultValue={values.name}
              placeholder="Northside"
              autoFocus
              required
            />
          </Field>

          <Field
            label="Description"
            htmlFor="description"
            hint="Optional. What this group covers."
            error={err("description")}
          >
            <Textarea
              id="description"
              name="description"
              rows={2}
              defaultValue={values.description}
              placeholder="Everything north of the river."
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Members"
          description={
            members.length === 1
              ? "1 person selected."
              : `${members.length} people selected.`
          }
        />

        <CardBody className="space-y-5">
          {people.length === 0 ? (
            <p className="text-sm text-ink-muted">
              There is nobody to add yet. Create a team member first.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {people.map((person) => {
                const checked = members.includes(person.id);

                return (
                  <label
                    key={person.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                      checked
                        ? "border-brand bg-brand/6"
                        : "border-line hover:border-line-strong",
                      !person.isActive && "opacity-60",
                    )}
                  >
                    <Checkbox checked={checked} onChange={() => toggle(person.id)} />
                    <Avatar name={person.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {person.name}
                      </span>
                      <span className="block truncate text-xs text-ink-subtle">
                        {person.isActive
                          ? (person.position ?? "—")
                          : "Deactivated"}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <Field
            label="Lead"
            htmlFor="leadId"
            hint={
              leadOptions.length === 0
                ? "Add members above, then choose which one leads."
                : "Who answers for this group's work."
            }
            error={err("leadId")}
          >
            <Select
              id="leadId"
              name="leadId"
              value={leadId}
              onChange={(event) => setLeadId(event.target.value)}
              disabled={leadOptions.length === 0}
            >
              <option value="">No lead</option>
              {leadOptions.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <Link
            href={values.id ? `/team/groups/${values.id}` : "/team/groups"}
            className={buttonClasses("ghost", "md")}
          >
            Cancel
          </Link>
          <SubmitButton>{isEdit ? "Save changes" : "Create group"}</SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

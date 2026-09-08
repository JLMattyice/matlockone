"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { createLead, updateLead } from "./actions";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  LEAD_STATUS_META,
  LEAD_STATUSES,
  type LeadStatus,
} from "@/lib/constants";

export type LeadFormValues = {
  id?: string;
  name: string;
  businessName: string;
  email: string;
  phone: string;
  source: string;
  status: LeadStatus;
  estimatedValue: string;
  assignedToId: string;
  lostReason: string;
};

export function LeadForm({
  values,
  team,
  currencySymbol,
}: {
  values: LeadFormValues;
  team: { id: string; name: string }[];
  currencySymbol: string;
}) {
  const isEdit = Boolean(values.id);
  const [state, formAction] = useActionState<ActionState, FormData>(
    isEdit ? updateLead : createLead,
    IDLE,
  );

  const [status, setStatus] = useState<LeadStatus>(values.status);
  const err = (key: string) => state.fieldErrors?.[key];

  return (
    <form action={formAction}>
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <Card>
        <CardHeader
          title="Lead details"
          description="Who got in touch, and what the job might be worth."
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
                placeholder="Dana Whitfield"
              />
            </Field>

            <Field
              label="Business name"
              htmlFor="businessName"
              hint="Leave blank for a residential enquiry."
            >
              <Input
                id="businessName"
                name="businessName"
                defaultValue={values.businessName}
              />
            </Field>

            <Field label="Email" htmlFor="email" error={err("email")}>
              <Input
                id="email"
                name="email"
                type="email"
                defaultValue={values.email}
              />
            </Field>

            <Field label="Phone" htmlFor="phone">
              <Input
                id="phone"
                name="phone"
                type="tel"
                defaultValue={values.phone}
                placeholder="(919) 555-0142"
              />
            </Field>

            <Field
              label="How they found you"
              htmlFor="source"
              hint="Feeds the lead-source reporting."
            >
              <Select id="source" name="source" defaultValue={values.source}>
                <option value="">Not recorded</option>
                {LEAD_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {LEAD_SOURCE_LABELS[source]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Estimated value"
              htmlFor="estimatedValue"
              hint="A rough figure is fine — it drives the pipeline total."
            >
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-subtle">
                  {currencySymbol}
                </span>
                <Input
                  id="estimatedValue"
                  name="estimatedValue"
                  inputMode="decimal"
                  defaultValue={values.estimatedValue}
                  placeholder="2,500"
                  className="tabular pl-7"
                />
              </div>
            </Field>

            <Field label="Status" htmlFor="status">
              <Select
                id="status"
                name="status"
                value={status}
                onChange={(e) => setStatus(e.target.value as LeadStatus)}
              >
                {LEAD_STATUSES.map((option) => (
                  <option key={option} value={option}>
                    {LEAD_STATUS_META[option].label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Owner" htmlFor="assignedToId">
              <Select
                id="assignedToId"
                name="assignedToId"
                defaultValue={values.assignedToId}
              >
                <option value="">Unassigned</option>
                {team.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {status === "LOST" ? (
            <Field
              label="Why was it lost?"
              htmlFor="lostReason"
              hint="Worth recording — it is the most useful field in lead reporting."
            >
              <Textarea
                id="lostReason"
                name="lostReason"
                rows={2}
                defaultValue={values.lostReason}
                placeholder="Went with a cheaper quote."
              />
            </Field>
          ) : null}
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <Link
            href={values.id ? `/leads/${values.id}` : "/leads"}
            className={buttonClasses("ghost", "md")}
          >
            Cancel
          </Link>
          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Creating…"}>
            {isEdit ? "Save changes" : "Create lead"}
          </SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

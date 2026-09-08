"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { createExpense, updateExpense } from "./actions";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormError, Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type ExpenseCategory,
} from "@/lib/constants";

export type ExpenseFormValues = {
  id?: string;
  description: string;
  category: ExpenseCategory;
  vendor: string;
  amount: string;
  tax: string;
  method: string;
  reference: string;
  spentAt: string;
  jobId: string;
  clientId: string;
  billable: boolean;
  reimbursable: boolean;
  paidById: string;
};

export type ExpenseJobOption = {
  id: string;
  number: string;
  title: string;
  client: { id: string; displayName: string } | null;
};

export function ExpenseForm({
  values,
  jobs,
  clients,
  payers,
  currencySymbol,
  jobLabel,
  clientLabel,
}: {
  values: ExpenseFormValues;
  jobs: ExpenseJobOption[];
  clients: { id: string; displayName: string }[];
  payers: { id: string; name: string }[];
  currencySymbol: string;
  jobLabel: string;
  clientLabel: string;
}) {
  const isEdit = Boolean(values.id);
  const [state, formAction] = useActionState<ActionState, FormData>(
    isEdit ? updateExpense : createExpense,
    IDLE,
  );

  const [jobId, setJobId] = useState(values.jobId);
  const [reimbursable, setReimbursable] = useState(values.reimbursable);

  // A job carries its own client, so the picker steps aside rather than
  // offering a second answer to a question already settled.
  const selectedJob = jobs.find((job) => job.id === jobId) ?? null;
  const err = (key: string) => state.fieldErrors?.[key];

  return (
    <form action={formAction}>
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <Card>
        <CardHeader
          title="Expense details"
          description="What was bought, what it cost, and which work it belongs to."
        />

        <CardBody className="space-y-5">
          <FormError>{state.error}</FormError>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Description"
              htmlFor="description"
              required
              error={err("description")}
              className="sm:col-span-2"
            >
              <Input
                id="description"
                name="description"
                defaultValue={values.description}
                required
                autoFocus={!isEdit}
                placeholder="4in PVC and fittings"
              />
            </Field>

            <Field label="Category" htmlFor="category" error={err("category")}>
              <Select id="category" name="category" defaultValue={values.category}>
                {EXPENSE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {EXPENSE_CATEGORY_LABELS[category]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Vendor" htmlFor="vendor" hint="Who was paid.">
              <Input
                id="vendor"
                name="vendor"
                defaultValue={values.vendor}
                placeholder="Ferguson Supply"
              />
            </Field>

            <Field
              label="Amount"
              htmlFor="amount"
              required
              error={err("amount")}
              hint="The receipt total, tax included."
            >
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-subtle">
                  {currencySymbol}
                </span>
                <Input
                  id="amount"
                  name="amount"
                  inputMode="decimal"
                  defaultValue={values.amount}
                  required
                  placeholder="184.20"
                  className="tabular pl-7"
                />
              </div>
            </Field>

            <Field
              label="Tax included"
              htmlFor="tax"
              error={err("tax")}
              hint="The tax portion of that total. Leave blank if none."
            >
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-subtle">
                  {currencySymbol}
                </span>
                <Input
                  id="tax"
                  name="tax"
                  inputMode="decimal"
                  defaultValue={values.tax}
                  placeholder="0.00"
                  className="tabular pl-7"
                />
              </div>
            </Field>

            <Field label="Date" htmlFor="spentAt" required error={err("spentAt")}>
              <Input
                id="spentAt"
                name="spentAt"
                type="date"
                defaultValue={values.spentAt}
                required
                className="tabular"
              />
            </Field>

            <Field label="Paid with" htmlFor="method">
              <Select id="method" name="method" defaultValue={values.method}>
                {PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {PAYMENT_METHOD_LABELS[method]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Reference"
              htmlFor="reference"
              hint="Check number, card last four, order number."
            >
              <Input
                id="reference"
                name="reference"
                defaultValue={values.reference}
                placeholder="•••• 4412"
              />
            </Field>

            <Field label="Paid by" htmlFor="paidById" hint="Who actually spent it.">
              <Select id="paidById" name="paidById" defaultValue={values.paidById}>
                <option value="">The business</option>
                {payers.map((payer) => (
                  <option key={payer.id} value={payer.id}>
                    {payer.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 border-t border-line pt-5 sm:grid-cols-2">
            <Field
              label={jobLabel}
              htmlFor="jobId"
              hint={`Booking this to a ${jobLabel.toLowerCase()} puts it against that job's cost.`}
            >
              <Select
                id="jobId"
                name="jobId"
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
              >
                <option value="">Not job-specific</option>
                {jobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.number} · {job.title}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={clientLabel}
              htmlFor="clientId"
              hint={
                selectedJob
                  ? `Taken from the selected ${jobLabel.toLowerCase()}.`
                  : undefined
              }
            >
              {selectedJob ? (
                <Input
                  id="clientId"
                  value={selectedJob.client?.displayName ?? "None"}
                  readOnly
                  disabled
                />
              ) : (
                <Select id="clientId" name="clientId" defaultValue={values.clientId}>
                  <option value="">Not client-specific</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          <div className="space-y-3 border-t border-line pt-5">
            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox
                name="billable"
                defaultChecked={values.billable}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium text-ink">
                  Rebill to the {clientLabel.toLowerCase()}
                </span>
                <span className="mt-0.5 block text-xs text-ink-subtle">
                  Flags the cost to be passed on. It does not add itself to an
                  invoice — you decide that when you raise one.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox
                name="reimbursable"
                checked={reimbursable}
                onChange={(e) => setReimbursable(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium text-ink">
                  Owed back to whoever paid
                </span>
                <span className="mt-0.5 block text-xs text-ink-subtle">
                  Tracks it as an outstanding reimbursement until it is settled.
                </span>
              </span>
            </label>
          </div>
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <Link
            href={values.id ? `/expenses/${values.id}` : "/expenses"}
            className={buttonClasses("ghost", "md")}
          >
            Cancel
          </Link>
          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Recording…"}>
            {isEdit ? "Save changes" : "Record expense"}
          </SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

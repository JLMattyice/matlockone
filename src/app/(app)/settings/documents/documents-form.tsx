"use client";

import { useActionState } from "react";

import { updateDocumentDefaults } from "../actions";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

export type DocumentValues = {
  taxRate: string;
  invoicePrefix: string;
  invoiceNextNumber: number;
  estimatePrefix: string;
  estimateNextNumber: number;
  jobPrefix: string;
  jobNextNumber: number;
  defaultPaymentTermsDays: number;
  defaultEstimateValidDays: number;
  invoiceFooter: string | null;
  estimateFooter: string | null;
  readOnly: boolean;
};

export function DocumentsForm({ values }: { values: DocumentValues }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateDocumentDefaults,
    IDLE,
  );

  const disabled = values.readOnly;
  const err = (key: string) => state.fieldErrors?.[key];

  return (
    <form action={formAction} className="space-y-6">
      <Card>
        <CardHeader
          title="Numbering"
          description="Prefix and next number for each document type. Counters only move forward."
        />

        <CardBody className="space-y-4">
          <NumberingRow
            label="Invoices"
            prefixName="invoicePrefix"
            prefixValue={values.invoicePrefix}
            counterName="invoiceNextNumber"
            counterValue={values.invoiceNextNumber}
            error={err("invoiceNextNumber")}
            disabled={disabled}
          />
          <NumberingRow
            label="Estimates"
            prefixName="estimatePrefix"
            prefixValue={values.estimatePrefix}
            counterName="estimateNextNumber"
            counterValue={values.estimateNextNumber}
            error={err("estimateNextNumber")}
            disabled={disabled}
          />
          <NumberingRow
            label="Jobs"
            prefixName="jobPrefix"
            prefixValue={values.jobPrefix}
            counterName="jobNextNumber"
            counterValue={values.jobNextNumber}
            error={err("jobNextNumber")}
            disabled={disabled}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Defaults"
          description="Pre-filled on every new estimate and invoice. Each document can override them."
        />

        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Sales tax rate"
              htmlFor="taxRate"
              hint="Percent, e.g. 8.25"
              error={err("taxRate")}
            >
              <Input
                id="taxRate"
                name="taxRate"
                inputMode="decimal"
                defaultValue={values.taxRate}
                disabled={disabled}
                className="tabular"
              />
            </Field>

            <Field
              label="Payment terms"
              htmlFor="defaultPaymentTermsDays"
              hint="Days until an invoice is due"
            >
              <Input
                id="defaultPaymentTermsDays"
                name="defaultPaymentTermsDays"
                type="number"
                min={0}
                max={365}
                defaultValue={values.defaultPaymentTermsDays}
                disabled={disabled}
                className="tabular"
              />
            </Field>

            <Field
              label="Estimate validity"
              htmlFor="defaultEstimateValidDays"
              hint="Days before it expires"
            >
              <Input
                id="defaultEstimateValidDays"
                name="defaultEstimateValidDays"
                type="number"
                min={1}
                max={365}
                defaultValue={values.defaultEstimateValidDays}
                disabled={disabled}
                className="tabular"
              />
            </Field>
          </div>

          <Field
            label="Invoice footer"
            htmlFor="invoiceFooter"
            hint="Printed at the bottom of every invoice."
          >
            <Textarea
              id="invoiceFooter"
              name="invoiceFooter"
              rows={3}
              defaultValue={values.invoiceFooter ?? ""}
              placeholder="Thank you for your business. Payment is due within 30 days."
              disabled={disabled}
            />
          </Field>

          <Field
            label="Estimate footer"
            htmlFor="estimateFooter"
            hint="Printed at the bottom of every estimate."
          >
            <Textarea
              id="estimateFooter"
              name="estimateFooter"
              rows={3}
              defaultValue={values.estimateFooter ?? ""}
              placeholder="This estimate is valid for 30 days from the date issued."
              disabled={disabled}
            />
          </Field>
        </CardBody>

        {disabled ? null : (
          <CardFooter>
            <ActionStatus state={state} className="mr-auto" />
            <SubmitButton />
          </CardFooter>
        )}
      </Card>
    </form>
  );
}

function NumberingRow({
  label,
  prefixName,
  prefixValue,
  counterName,
  counterValue,
  error,
  disabled,
}: {
  label: string;
  prefixName: string;
  prefixValue: string;
  counterName: string;
  counterValue: number;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid items-start gap-3 sm:grid-cols-[7rem_1fr_1fr_auto]">
      <span className="pt-2.5 text-sm font-medium text-ink">{label}</span>

      <Field label="Prefix" htmlFor={prefixName}>
        <Input
          id={prefixName}
          name={prefixName}
          defaultValue={prefixValue}
          disabled={disabled}
          className="font-mono"
        />
      </Field>

      <Field label="Next number" htmlFor={counterName} error={error}>
        <Input
          id={counterName}
          name={counterName}
          type="number"
          min={1}
          defaultValue={counterValue}
          disabled={disabled}
          className="tabular"
        />
      </Field>

      <div className="pt-7 text-sm text-ink-subtle">
        <span className="font-mono">
          {prefixValue}
          {counterValue}
        </span>
      </div>
    </div>
  );
}

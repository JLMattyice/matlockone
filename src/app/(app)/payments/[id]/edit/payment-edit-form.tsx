"use client";

import Link from "next/link";
import { useActionState } from "react";

import { updatePayment } from "@/app/(app)/invoices/actions";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@/lib/constants";

export type PaymentEditValues = {
  id: string;
  amount: string;
  method: string;
  receivedAt: string;
  reference: string;
  notes: string;
};

export function PaymentEditForm({
  values,
  back,
  currencySymbol,
  processor,
}: {
  values: PaymentEditValues;
  /** Where Save and Cancel go: the page the payment was opened from. */
  back: string;
  currencySymbol: string;
  /** The processor's name when one reported this payment, else null. */
  processor: string | null;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updatePayment,
    IDLE,
  );

  // React clears the form when the save returns; this puts the typing
  // back when the answer was a refusal.
  const keep = useKeepTyped(state);
  const err = (key: string) => state.fieldErrors?.[key];

  // A processor's own record of the money is shown, not offered for editing.
  const locked = processor !== null;

  return (
    <form ref={keep} action={formAction}>
      <input type="hidden" name="id" value={values.id} />
      <input type="hidden" name="back" value={back} />

      <Card>
        <CardHeader
          title="Payment details"
          description={
            locked
              ? `Taken through ${processor}. The amount, method and date are ${processor}'s record of it; the reference and notes are yours.`
              : "Fix the amount, the method or the day it came in. The invoice's balance follows."
          }
        />

        <CardBody className="space-y-5">
          <FormError>{state.error}</FormError>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Amount" htmlFor="amount" required={!locked} error={err("amount")}>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-subtle">
                  {currencySymbol}
                </span>
                <Input
                  id="amount"
                  name="amount"
                  defaultValue={values.amount}
                  inputMode="decimal"
                  required={!locked}
                  disabled={locked}
                  className="tabular pl-7"
                />
              </div>
            </Field>

            <Field label="Method" htmlFor="method">
              <Select
                id="method"
                name="method"
                defaultValue={values.method}
                disabled={locked}
              >
                {PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {PAYMENT_METHOD_LABELS[method]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Received"
              htmlFor="receivedAt"
              required={!locked}
              error={err("receivedAt")}
            >
              <Input
                id="receivedAt"
                name="receivedAt"
                type="date"
                defaultValue={values.receivedAt}
                required={!locked}
                disabled={locked}
              />
            </Field>

            <Field label="Reference" htmlFor="reference" hint="Check number, transaction id.">
              <Input
                id="reference"
                name="reference"
                defaultValue={values.reference}
                placeholder="Optional"
              />
            </Field>

            <Field
              label="Notes"
              htmlFor="notes"
              hint="Internal — the client never sees these."
              className="sm:col-span-2"
            >
              <Textarea
                id="notes"
                name="notes"
                rows={3}
                defaultValue={values.notes}
                placeholder="Optional"
              />
            </Field>
          </div>
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <Link href={back} className={buttonClasses("ghost", "md")}>
            Cancel
          </Link>
          <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

import { createEstimate, updateEstimate } from "./actions";
import {
  LineItemEditor,
  type PriceBookOption,
} from "@/components/documents/line-item-editor";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import type { DiscountType } from "@/lib/constants";
import type { LineDraft } from "@/lib/line-draft";

export type EstimateClientChoice = {
  id: string;
  displayName: string;
  email: string | null;
  taxExempt: boolean;
  addresses: {
    id: string;
    line1: string;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    isPrimary: boolean;
  }[];
};

export type EstimateFormValues = {
  id?: string;
  clientId: string;
  addressId: string;
  title: string;
  /** "YYYY-MM-DD" */
  issueDate: string;
  expiresAt: string;
  notes: string;
  terms: string;
  discountType: DiscountType;
  discountValue: string;
  taxRate: string;
  lines: LineDraft[];
};

export function EstimateForm({
  values,
  clients,
  priceBook,
  currency,
  locale,
  currencySymbol,
}: {
  values: EstimateFormValues;
  clients: EstimateClientChoice[];
  priceBook: PriceBookOption[];
  currency: string;
  locale: string;
  currencySymbol: string;
}) {
  const isEdit = Boolean(values.id);
  const [state, formAction] = useActionState<ActionState, FormData>(
    isEdit ? updateEstimate : createEstimate,
    IDLE,
  );

  const [clientId, setClientId] = useState(values.clientId);
  const [addressId, setAddressId] = useState(values.addressId);

  const err = (key: string) => state.fieldErrors?.[key];

  const client = useMemo(
    () => clients.find((c) => c.id === clientId),
    [clients, clientId],
  );
  const addresses = client?.addresses ?? [];

  function onClientChange(next: string) {
    setClientId(next);
    const chosen = clients.find((c) => c.id === next);
    setAddressId(chosen?.addresses.find((a) => a.isPrimary)?.id ?? "");
  }

  return (
    <form action={formAction} className="space-y-6">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <FormError>{state.error}</FormError>

      <Card>
        <CardHeader
          title="Who and when"
          description="The client this quote is for, and how long it stands."
        />

        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Client" htmlFor="clientId" required error={err("clientId")}>
            <Select
              id="clientId"
              name="clientId"
              value={clientId}
              onChange={(e) => onClientChange(e.target.value)}
              required
            >
              <option value="">Choose a client…</option>
              {clients.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Service address"
            htmlFor="addressId"
            hint={
              clientId && addresses.length === 0
                ? "This client has no address on file."
                : undefined
            }
          >
            <Select
              id="addressId"
              name="addressId"
              value={addressId}
              onChange={(e) => setAddressId(e.target.value)}
              disabled={!clientId || addresses.length === 0}
            >
              <option value="">Not specified</option>
              {addresses.map((address) => (
                <option key={address.id} value={address.id}>
                  {[address.line1, address.city, address.state]
                    .filter(Boolean)
                    .join(", ")}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Title"
            htmlFor="title"
            className="sm:col-span-2"
            hint="Shown at the top of the estimate the client sees."
          >
            <Input
              id="title"
              name="title"
              defaultValue={values.title}
              placeholder="AC unit replacement"
            />
          </Field>

          <Field
            label="Issue date"
            htmlFor="issueDate"
            required
            error={err("issueDate")}
          >
            <Input
              id="issueDate"
              name="issueDate"
              type="date"
              defaultValue={values.issueDate}
              required
            />
          </Field>

          <Field
            label="Valid until"
            htmlFor="expiresAt"
            hint="After this date it shows as expired."
          >
            <Input
              id="expiresAt"
              name="expiresAt"
              type="date"
              defaultValue={values.expiresAt}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Line items"
          description="Services, materials and labor. Totals recalculate as you type."
        />
        <CardBody>
          {err("lineItems") ? (
            <p className="mb-3 text-sm text-danger">{err("lineItems")}</p>
          ) : null}

          <LineItemEditor
            initialLines={values.lines}
            priceBook={priceBook}
            currency={currency}
            locale={locale}
            currencySymbol={currencySymbol}
            initialDiscountType={values.discountType}
            initialDiscountValue={values.discountValue}
            initialTaxRate={values.taxRate}
            taxExemptClient={client?.taxExempt ?? false}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Notes and terms" />

        <CardBody className="space-y-4">
          <Field
            label="Notes"
            htmlFor="notes"
            hint="Shown to the client under the line items."
          >
            <Textarea
              id="notes"
              name="notes"
              rows={3}
              defaultValue={values.notes}
              placeholder="Pricing includes haul-away of the old unit and a one-year labor warranty."
            />
          </Field>

          <Field label="Terms" htmlFor="terms" hint="Printed at the foot of the document.">
            <Textarea
              id="terms"
              name="terms"
              rows={2}
              defaultValue={values.terms}
            />
          </Field>
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <Link
            href={values.id ? `/estimates/${values.id}` : "/estimates"}
            className={buttonClasses("ghost", "md")}
          >
            Cancel
          </Link>
          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Creating…"}>
            {isEdit ? "Save changes" : "Create estimate"}
          </SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

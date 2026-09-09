"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

import { createInvoice, updateInvoice } from "./actions";
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

export type InvoiceClientChoice = {
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

export type InvoiceFormValues = {
  id?: string;
  clientId: string;
  addressId: string;
  jobId: string;
  title: string;
  issueDate: string;
  dueDate: string;
  paymentTermsDays: number;
  notes: string;
  terms: string;
  discountType: DiscountType;
  discountValue: string;
  taxRate: string;
  lines: LineDraft[];
};

const TERM_PRESETS = [0, 7, 14, 30, 45, 60, 90];

export function InvoiceForm({
  values,
  clients,
  priceBook,
  currency,
  locale,
  currencySymbol,
}: {
  values: InvoiceFormValues;
  clients: InvoiceClientChoice[];
  priceBook: PriceBookOption[];
  currency: string;
  locale: string;
  currencySymbol: string;
}) {
  const isEdit = Boolean(values.id);
  const [state, formAction] = useActionState<ActionState, FormData>(
    isEdit ? updateInvoice : createInvoice,
    IDLE,
  );

  const [clientId, setClientId] = useState(values.clientId);
  const [addressId, setAddressId] = useState(values.addressId);
  const [issueDate, setIssueDate] = useState(values.issueDate);
  const [terms, setTerms] = useState(values.paymentTermsDays);
  const [dueDate, setDueDate] = useState(values.dueDate);

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

  /** Terms and issue date drive the due date, but a typed date wins. */
  function applyTerms(days: number, from = issueDate) {
    setTerms(days);
    const base = new Date(`${from}T12:00:00`);
    if (Number.isNaN(base.getTime())) return;
    const due = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    setDueDate(due.toISOString().slice(0, 10));
  }

  const termPresets = TERM_PRESETS.includes(terms)
    ? TERM_PRESETS
    : [...TERM_PRESETS, terms].sort((a, b) => a - b);

  return (
    <form action={formAction} className="space-y-6">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      {values.jobId ? (
        <input type="hidden" name="jobId" value={values.jobId} />
      ) : null}

      <FormError>{state.error}</FormError>

      <Card>
        <CardHeader
          title="Bill to"
          description="Who owes this, and when it falls due."
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
            label="Address"
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

          <Field label="Title" htmlFor="title" className="sm:col-span-2">
            <Input
              id="title"
              name="title"
              defaultValue={values.title}
              placeholder="Monthly service package"
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
              value={issueDate}
              onChange={(e) => {
                setIssueDate(e.target.value);
                applyTerms(terms, e.target.value);
              }}
              required
            />
          </Field>

          <Field label="Payment terms" htmlFor="paymentTermsDays">
            <Select
              id="paymentTermsDays"
              name="paymentTermsDays"
              value={String(terms)}
              onChange={(e) => applyTerms(Number(e.target.value))}
            >
              {termPresets.map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? "Due on receipt" : `Net ${days}`}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Due date"
            htmlFor="dueDate"
            hint="Set by the terms above; change it here if needed."
          >
            <Input
              id="dueDate"
              name="dueDate"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
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
          <Field label="Notes" htmlFor="notes" hint="Shown to the client.">
            <Textarea
              id="notes"
              name="notes"
              rows={3}
              defaultValue={values.notes}
              placeholder="Thank you for your business."
            />
          </Field>

          <Field label="Terms" htmlFor="terms" hint="Printed at the foot.">
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
            href={values.id ? `/invoices/${values.id}` : "/invoices"}
            className={buttonClasses("ghost", "md")}
          >
            Cancel
          </Link>
          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Creating…"}>
            {isEdit ? "Save changes" : "Create invoice"}
          </SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

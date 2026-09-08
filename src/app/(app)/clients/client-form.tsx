"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";
import { MapPin, Plus, Trash2 } from "lucide-react";

import { createClient, updateClient } from "./actions";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormError, Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { emptyAddress, type AddressDraft } from "@/lib/address-draft";
import {
  CLIENT_STATUS_META,
  CLIENT_STATUSES,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  type ClientStatus,
  type ClientType,
} from "@/lib/constants";
import { cn } from "@/lib/utils";

export type ClientFormValues = {
  id?: string;
  type: ClientType;
  firstName: string;
  lastName: string;
  businessName: string;
  email: string;
  phone: string;
  mobilePhone: string;
  website: string;
  status: ClientStatus;
  source: string;
  taxExempt: boolean;
  addresses: AddressDraft[];
};

/** Empty strings become null so the database stores absence, not "". */
function serializeAddresses(addresses: AddressDraft[]) {
  const blank = (value: string) => (value.trim() === "" ? null : value.trim());

  return JSON.stringify(
    addresses
      .filter((address) => address.line1.trim() !== "")
      .map((address) => ({
        id: address.id,
        label: blank(address.label),
        line1: address.line1.trim(),
        line2: blank(address.line2),
        city: blank(address.city),
        state: blank(address.state),
        postalCode: blank(address.postalCode),
        isPrimary: address.isPrimary,
        isBilling: address.isBilling,
        notes: blank(address.notes),
      })),
  );
}

export function ClientForm({
  values,
  clientLabel,
}: {
  values: ClientFormValues;
  clientLabel: string;
}) {
  const isEdit = Boolean(values.id);
  const [state, formAction] = useActionState<ActionState, FormData>(
    isEdit ? updateClient : createClient,
    IDLE,
  );

  const [type, setType] = useState<ClientType>(values.type);
  const [addresses, setAddresses] = useState<AddressDraft[]>(
    values.addresses.length ? values.addresses : [emptyAddress(true)],
  );

  const err = (key: string) => state.fieldErrors?.[key];
  const typeName = useId();

  function updateAddress(key: string, patch: Partial<AddressDraft>) {
    setAddresses((current) =>
      current.map((address) =>
        address.key === key ? { ...address, ...patch } : address,
      ),
    );
  }

  function setPrimary(key: string) {
    setAddresses((current) =>
      current.map((address) => ({ ...address, isPrimary: address.key === key })),
    );
  }

  function removeAddress(key: string) {
    setAddresses((current) => {
      const next = current.filter((address) => address.key !== key);
      // Something always has to be primary, or the list view has no address.
      if (next.length && !next.some((address) => address.isPrimary)) {
        next[0] = { ...next[0], isPrimary: true };
      }
      return next.length ? next : [emptyAddress(true)];
    });
  }

  return (
    <form action={formAction} className="space-y-6">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <input
        type="hidden"
        name="addressesJson"
        value={serializeAddresses(addresses)}
      />

      <FormError>{state.error}</FormError>

      <Card>
        <CardHeader
          title="Details"
          description={`Who this ${clientLabel.toLowerCase()} is and how to reach them.`}
        />

        <CardBody className="space-y-5">
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink">Type</legend>
            <div className="flex gap-2">
              {(["PERSON", "BUSINESS"] as const).map((option) => (
                <label
                  key={option}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2 text-sm transition-colors",
                    type === option
                      ? "border-brand bg-brand/8 font-medium text-brand"
                      : "border-line text-ink-muted hover:border-line-strong",
                  )}
                >
                  <input
                    type="radio"
                    name="type"
                    value={option}
                    checked={type === option}
                    onChange={() => setType(option)}
                    className="sr-only"
                    aria-describedby={typeName}
                  />
                  {option === "PERSON" ? "Individual" : "Business"}
                </label>
              ))}
            </div>
          </fieldset>

          {type === "BUSINESS" ? (
            <Field
              label="Business name"
              htmlFor="businessName"
              required
              error={err("businessName")}
            >
              <Input
                id="businessName"
                name="businessName"
                defaultValue={values.businessName}
                placeholder="Harbor Point Property Group"
              />
            </Field>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={type === "BUSINESS" ? "Contact first name" : "First name"}
              htmlFor="firstName"
              required={type === "PERSON"}
              error={err("firstName")}
            >
              <Input
                id="firstName"
                name="firstName"
                defaultValue={values.firstName}
                autoComplete="given-name"
              />
            </Field>

            <Field
              label={type === "BUSINESS" ? "Contact last name" : "Last name"}
              htmlFor="lastName"
              error={err("lastName")}
            >
              <Input
                id="lastName"
                name="lastName"
                defaultValue={values.lastName}
                autoComplete="family-name"
              />
            </Field>

            <Field label="Email" htmlFor="email" error={err("email")}>
              <Input
                id="email"
                name="email"
                type="email"
                defaultValue={values.email}
                placeholder="name@example.com"
              />
            </Field>

            <Field label="Phone" htmlFor="phone" error={err("phone")}>
              <Input
                id="phone"
                name="phone"
                type="tel"
                defaultValue={values.phone}
                placeholder="(919) 555-0142"
              />
            </Field>

            <Field label="Mobile" htmlFor="mobilePhone">
              <Input
                id="mobilePhone"
                name="mobilePhone"
                type="tel"
                defaultValue={values.mobilePhone}
              />
            </Field>

            <Field label="Website" htmlFor="website">
              <Input
                id="website"
                name="website"
                defaultValue={values.website}
                placeholder="https://"
              />
            </Field>

            <Field label="Status" htmlFor="status">
              <Select id="status" name="status" defaultValue={values.status}>
                {CLIENT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {CLIENT_STATUS_META[status].label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="How they found you"
              htmlFor="source"
              hint="Used in reporting on where work comes from."
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
          </div>

          <label className="flex items-center gap-2.5 text-sm text-ink-muted">
            <Checkbox name="taxExempt" defaultChecked={values.taxExempt} />
            Tax exempt — do not add sales tax to their documents
          </label>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Addresses"
          description="Service locations and where to send the bill."
          action={
            <button
              type="button"
              onClick={() => setAddresses((c) => [...c, emptyAddress(c.length === 0)])}
              className={buttonClasses("outline", "sm")}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              Add address
            </button>
          }
        />

        <CardBody className="space-y-4">
          {err("addresses") ? (
            <p className="text-xs text-danger">
              Every address needs a street line, or remove the empty one.
            </p>
          ) : null}

          {addresses.map((address, index) => (
            <div
              key={address.key}
              className="rounded-card border border-line bg-surface-2 p-4"
            >
              <div className="mb-3 flex items-center gap-2">
                <MapPin
                  className="h-4 w-4 text-ink-subtle"
                  strokeWidth={1.75}
                  aria-hidden
                />
                <input
                  value={address.label}
                  onChange={(e) =>
                    updateAddress(address.key, { label: e.target.value })
                  }
                  placeholder={`Address ${index + 1}`}
                  aria-label={`Label for address ${index + 1}`}
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm font-medium text-ink placeholder:text-ink-subtle focus:outline-none"
                />

                {addresses.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeAddress(address.key)}
                    aria-label={`Remove address ${index + 1}`}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-6">
                <div className="sm:col-span-4">
                  <Input
                    value={address.line1}
                    onChange={(e) =>
                      updateAddress(address.key, { line1: e.target.value })
                    }
                    placeholder="Street address"
                    aria-label="Street address"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Input
                    value={address.line2}
                    onChange={(e) =>
                      updateAddress(address.key, { line2: e.target.value })
                    }
                    placeholder="Unit / suite"
                    aria-label="Unit or suite"
                  />
                </div>
                <div className="sm:col-span-3">
                  <Input
                    value={address.city}
                    onChange={(e) =>
                      updateAddress(address.key, { city: e.target.value })
                    }
                    placeholder="City"
                    aria-label="City"
                  />
                </div>
                <div className="sm:col-span-1">
                  <Input
                    value={address.state}
                    onChange={(e) =>
                      updateAddress(address.key, { state: e.target.value })
                    }
                    placeholder="State"
                    aria-label="State"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Input
                    value={address.postalCode}
                    onChange={(e) =>
                      updateAddress(address.key, { postalCode: e.target.value })
                    }
                    placeholder="ZIP"
                    aria-label="ZIP code"
                  />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  <input
                    type="radio"
                    name="primaryAddress"
                    checked={address.isPrimary}
                    onChange={() => setPrimary(address.key)}
                    className="h-3.5 w-3.5 accent-[var(--brand)]"
                  />
                  Primary service address
                </label>

                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  <Checkbox
                    className="h-3.5 w-3.5"
                    checked={address.isBilling}
                    onChange={(e) =>
                      updateAddress(address.key, { isBilling: e.target.checked })
                    }
                  />
                  Billing address
                </label>
              </div>
            </div>
          ))}
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <Link
            href={values.id ? `/clients/${values.id}` : "/clients"}
            className={buttonClasses("ghost", "md")}
          >
            Cancel
          </Link>
          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Creating…"}>
            {isEdit ? "Save changes" : `Create ${clientLabel.toLowerCase()}`}
          </SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

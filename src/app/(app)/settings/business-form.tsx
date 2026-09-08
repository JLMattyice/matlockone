"use client";

import { useActionState } from "react";

import { updateBusinessProfile } from "./actions";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

const TIME_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
];

export type BusinessValues = {
  name: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  timeZone: string;
  currency: string;
  locale: string;
  readOnly: boolean;
};

export function BusinessForm({ values }: { values: BusinessValues }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateBusinessProfile,
    IDLE,
  );

  const disabled = values.readOnly;
  const err = (key: string) => state.fieldErrors?.[key];

  return (
    <form action={formAction}>
      <Card>
        <CardHeader
          title="Business profile"
          description="Appears on estimates, invoices and client-facing messages."
        />

        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business name" htmlFor="name" required error={err("name")}>
              <Input
                id="name"
                name="name"
                defaultValue={values.name}
                required
                disabled={disabled}
              />
            </Field>

            <Field
              label="Legal name"
              htmlFor="legalName"
              hint="Only if it differs from the trading name."
              error={err("legalName")}
            >
              <Input
                id="legalName"
                name="legalName"
                defaultValue={values.legalName ?? ""}
                disabled={disabled}
              />
            </Field>

            <Field label="Email" htmlFor="email" error={err("email")}>
              <Input
                id="email"
                name="email"
                type="email"
                defaultValue={values.email ?? ""}
                disabled={disabled}
              />
            </Field>

            <Field label="Phone" htmlFor="phone" error={err("phone")}>
              <Input
                id="phone"
                name="phone"
                type="tel"
                defaultValue={values.phone ?? ""}
                disabled={disabled}
              />
            </Field>

            <Field label="Website" htmlFor="website" className="sm:col-span-2">
              <Input
                id="website"
                name="website"
                defaultValue={values.website ?? ""}
                placeholder="https://"
                disabled={disabled}
              />
            </Field>
          </div>

          <div className="border-t border-line pt-5">
            <p className="mb-3 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
              Address
            </p>
            <div className="grid gap-4 sm:grid-cols-6">
              <Field label="Street" htmlFor="addressLine1" className="sm:col-span-4">
                <Input
                  id="addressLine1"
                  name="addressLine1"
                  defaultValue={values.addressLine1 ?? ""}
                  disabled={disabled}
                />
              </Field>

              <Field label="Suite / unit" htmlFor="addressLine2" className="sm:col-span-2">
                <Input
                  id="addressLine2"
                  name="addressLine2"
                  defaultValue={values.addressLine2 ?? ""}
                  disabled={disabled}
                />
              </Field>

              <Field label="City" htmlFor="city" className="sm:col-span-3">
                <Input
                  id="city"
                  name="city"
                  defaultValue={values.city ?? ""}
                  disabled={disabled}
                />
              </Field>

              <Field label="State" htmlFor="state" className="sm:col-span-1">
                <Input
                  id="state"
                  name="state"
                  defaultValue={values.state ?? ""}
                  disabled={disabled}
                />
              </Field>

              <Field label="ZIP" htmlFor="postalCode" className="sm:col-span-2">
                <Input
                  id="postalCode"
                  name="postalCode"
                  defaultValue={values.postalCode ?? ""}
                  disabled={disabled}
                />
              </Field>
            </div>
          </div>

          <div className="border-t border-line pt-5">
            <p className="mb-3 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
              Regional
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Time zone" htmlFor="timeZone" error={err("timeZone")}>
                <Select
                  id="timeZone"
                  name="timeZone"
                  defaultValue={values.timeZone}
                  disabled={disabled}
                >
                  {TIME_ZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace("_", " ")}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Currency" htmlFor="currency" error={err("currency")}>
                <Select
                  id="currency"
                  name="currency"
                  defaultValue={values.currency}
                  disabled={disabled}
                >
                  {["USD", "CAD", "GBP", "EUR", "AUD", "NZD"].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Number format" htmlFor="locale" error={err("locale")}>
                <Select
                  id="locale"
                  name="locale"
                  defaultValue={values.locale}
                  disabled={disabled}
                >
                  <option value="en-US">en-US</option>
                  <option value="en-GB">en-GB</option>
                  <option value="en-CA">en-CA</option>
                  <option value="en-AU">en-AU</option>
                </Select>
              </Field>

              <input type="hidden" name="country" value={values.country} />
            </div>
          </div>
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

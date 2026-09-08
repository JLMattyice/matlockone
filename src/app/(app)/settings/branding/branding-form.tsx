"use client";

import { useActionState, useState } from "react";
import { Briefcase, Users } from "lucide-react";

import { updateBranding } from "../actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { hexToRgbChannels, initials } from "@/lib/utils";

export type BrandingValues = {
  orgName: string;
  primaryColor: string;
  accentColor: string;
  logoUrl: string | null;
  labelJobSingular: string;
  labelJobPlural: string;
  labelClientSingular: string;
  labelClientPlural: string;
  readOnly: boolean;
};

export function BrandingForm({ values }: { values: BrandingValues }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateBranding,
    IDLE,
  );

  const [primary, setPrimary] = useState(values.primaryColor);
  const [jobPlural, setJobPlural] = useState(values.labelJobPlural);
  const [clientPlural, setClientPlural] = useState(values.labelClientPlural);

  const disabled = values.readOnly;
  const err = (key: string) => state.fieldErrors?.[key];
  const previewBrand = hexToRgbChannels(primary) ? primary : values.primaryColor;

  return (
    <form action={formAction} className="space-y-6">
      <Card>
        <CardHeader
          title="Brand"
          description="Colors and logo used across the app and on client documents."
        />

        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Primary color"
              htmlFor="primaryColor"
              hint="Buttons, links and highlights."
              error={err("primaryColor")}
            >
              <ColorInput
                id="primaryColor"
                name="primaryColor"
                value={primary}
                onChange={setPrimary}
                disabled={disabled}
              />
            </Field>

            <Field
              label="Accent color"
              htmlFor="accentColor"
              hint="Headings on printed documents."
              error={err("accentColor")}
            >
              <ColorInput
                id="accentColor"
                name="accentColor"
                defaultValue={values.accentColor}
                disabled={disabled}
              />
            </Field>
          </div>

          <Field
            label="Logo URL"
            htmlFor="logoUrl"
            hint="Uploads land with the file module in phase 6. A hosted image URL works now."
            error={err("logoUrl")}
          >
            <Input
              id="logoUrl"
              name="logoUrl"
              defaultValue={values.logoUrl ?? ""}
              placeholder="https://example.com/logo.png"
              disabled={disabled}
            />
          </Field>

          {/* Scoping --brand here shows the picked color immediately, using the
              same variable the real app layout sets. */}
          <div
            style={{ "--brand": previewBrand } as React.CSSProperties}
            className="rounded-card border border-line bg-surface-2 p-4"
          >
            <p className="mb-3 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
              Preview
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-xs font-bold text-brand-ink">
                {initials(values.orgName) || "WS"}
              </span>
              <span className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink">
                Send invoice
              </span>
              <Badge tone="accent">Confirmed</Badge>
              <span className="text-sm font-medium text-brand">View estimate</span>
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

      <Card>
        <CardHeader
          title="Terminology"
          description="Rename the core records to match how your trade talks."
        />

        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Job (singular)" htmlFor="labelJobSingular" required error={err("labelJobSingular")}>
              <Input
                id="labelJobSingular"
                name="labelJobSingular"
                defaultValue={values.labelJobSingular}
                required
                disabled={disabled}
              />
            </Field>

            <Field label="Jobs (plural)" htmlFor="labelJobPlural" required error={err("labelJobPlural")}>
              <Input
                id="labelJobPlural"
                name="labelJobPlural"
                value={jobPlural}
                onChange={(e) => setJobPlural(e.target.value)}
                required
                disabled={disabled}
              />
            </Field>

            <Field label="Client (singular)" htmlFor="labelClientSingular" required error={err("labelClientSingular")}>
              <Input
                id="labelClientSingular"
                name="labelClientSingular"
                defaultValue={values.labelClientSingular}
                required
                disabled={disabled}
              />
            </Field>

            <Field label="Clients (plural)" htmlFor="labelClientPlural" required error={err("labelClientPlural")}>
              <Input
                id="labelClientPlural"
                name="labelClientPlural"
                value={clientPlural}
                onChange={(e) => setClientPlural(e.target.value)}
                required
                disabled={disabled}
              />
            </Field>
          </div>

          <div className="rounded-card border border-line bg-surface-2 p-4">
            <p className="mb-3 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
              Navigation preview
            </p>
            <div className="flex flex-wrap gap-2">
              <NavPreview icon={<Briefcase className="h-4 w-4" strokeWidth={1.75} />}>
                {jobPlural || "Jobs"}
              </NavPreview>
              <NavPreview icon={<Users className="h-4 w-4" strokeWidth={1.75} />}>
                {clientPlural || "Clients"}
              </NavPreview>
            </div>
            <p className="mt-3 text-xs text-ink-subtle">
              Try &ldquo;Work Orders&rdquo; and &ldquo;Customers&rdquo;, or
              &ldquo;Visits&rdquo; and &ldquo;Accounts&rdquo;.
            </p>
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

function NavPreview({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-2.5 rounded-lg bg-surface px-2.5 py-2 text-sm text-ink-muted ring-1 ring-line">
      {icon}
      {children}
    </span>
  );
}

function ColorInput({
  id,
  name,
  value,
  defaultValue,
  onChange,
  disabled,
}: {
  id: string;
  name: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const [internal, setInternal] = useState(value ?? defaultValue ?? "#2563eb");
  const current = value ?? internal;

  function set(next: string) {
    setInternal(next);
    onChange?.(next);
  }

  return (
    <div className="flex gap-2">
      <input
        type="color"
        aria-label={`${name} swatch`}
        value={hexToRgbChannels(current) ? current : "#2563eb"}
        onChange={(e) => set(e.target.value)}
        disabled={disabled}
        className="h-9.5 w-12 shrink-0 cursor-pointer rounded-lg border border-line bg-surface p-1 disabled:cursor-not-allowed"
      />
      <Input
        id={id}
        name={name}
        value={current}
        onChange={(e) => set(e.target.value)}
        disabled={disabled}
        spellCheck={false}
        className="font-mono"
      />
    </div>
  );
}

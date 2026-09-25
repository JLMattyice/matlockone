"use client";

import { Fragment, useActionState, useState } from "react";
import { Briefcase, FileText, Target, Users } from "lucide-react";

import { updateBranding } from "../actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { useKeepTyped } from "@/components/ui/keep-typed";
import { IDLE, type ActionState } from "@/lib/action-state";
import { BUSINESS_TYPES, vocabularyColumns } from "@/lib/business-types";
import { hexToRgbChannels, initials } from "@/lib/utils";

export type BrandingValues = {
  orgName: string;
  primaryColor: string;
  accentColor: string;
  logoUrl: string | null;
  businessType: string;
  labelJobSingular: string;
  labelJobPlural: string;
  labelClientSingular: string;
  labelClientPlural: string;
  labelEstimateSingular: string;
  labelEstimatePlural: string;
  labelLeadSingular: string;
  labelLeadPlural: string;
  readOnly: boolean;
};

/** What each pair of inputs is called on screen. */
const TERM_TITLES: Record<string, string> = {
  job: "Work",
  client: "Customer record",
  estimate: "Estimate",
  lead: "Lead",
};

/** The label inputs, in the order they are shown. */
const TERMS = [
  { singular: "labelJobSingular", plural: "labelJobPlural", of: "job" },
  { singular: "labelClientSingular", plural: "labelClientPlural", of: "client" },
  {
    singular: "labelEstimateSingular",
    plural: "labelEstimatePlural",
    of: "estimate",
  },
  { singular: "labelLeadSingular", plural: "labelLeadPlural", of: "lead" },
] as const;

export function BrandingForm({ values }: { values: BrandingValues }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateBranding,
    IDLE,
  );

  // React clears the form when the save returns; this puts the typing
  // back when the answer was a refusal.
  const keep = useKeepTyped(state);

  const [primary, setPrimary] = useState(values.primaryColor);

  // Every label is controlled, because choosing a business type rewrites all
  // eight at once. They are still submitted as ordinary named inputs, so the
  // action reads the same form data whether they were typed or filled in.
  const [type, setType] = useState(values.businessType);
  const [labels, setLabels] = useState<Record<string, string>>({
    labelJobSingular: values.labelJobSingular,
    labelJobPlural: values.labelJobPlural,
    labelClientSingular: values.labelClientSingular,
    labelClientPlural: values.labelClientPlural,
    labelEstimateSingular: values.labelEstimateSingular,
    labelEstimatePlural: values.labelEstimatePlural,
    labelLeadSingular: values.labelLeadSingular,
    labelLeadPlural: values.labelLeadPlural,
  });

  /**
   * Switching type fills the boxes; it does not save them. Nothing is renamed
   * until Save is pressed, so a curious click can be undone by leaving the
   * page — and the words are visible before they are committed.
   */
  function applyType(next: string) {
    setType(next);
    setLabels(vocabularyColumns(next));
  }

  const setLabel = (name: string, value: string) =>
    setLabels((current) => ({ ...current, [name]: value }));

  const disabled = values.readOnly;
  const err = (key: string) => state.fieldErrors?.[key];
  const previewBrand = hexToRgbChannels(primary) ? primary : values.primaryColor;

  return (
    <form ref={keep} action={formAction} className="space-y-6">
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
          <Field
            label="Business type"
            htmlFor="businessType"
            hint="Fills the words below. Nothing is saved until you press Save, and you can edit any of them afterwards."
          >
            <Select
              id="businessType"
              name="businessType"
              value={type}
              onChange={(e) => applyType(e.target.value)}
              disabled={disabled}
            >
              {BUSINESS_TYPES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            {TERMS.map((term) => (
              <Fragment key={term.of}>
                <Field
                  label={`${TERM_TITLES[term.of]} (singular)`}
                  htmlFor={term.singular}
                  required
                  error={err(term.singular)}
                >
                  <Input
                    id={term.singular}
                    name={term.singular}
                    value={labels[term.singular]}
                    onChange={(e) => setLabel(term.singular, e.target.value)}
                    required
                    disabled={disabled}
                  />
                </Field>

                <Field
                  label={`${TERM_TITLES[term.of]} (plural)`}
                  htmlFor={term.plural}
                  required
                  error={err(term.plural)}
                >
                  <Input
                    id={term.plural}
                    name={term.plural}
                    value={labels[term.plural]}
                    onChange={(e) => setLabel(term.plural, e.target.value)}
                    required
                    disabled={disabled}
                  />
                </Field>
              </Fragment>
            ))}
          </div>

          <div className="rounded-card border border-line bg-surface-2 p-4">
            <p className="mb-3 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
              Navigation preview
            </p>
            <div className="flex flex-wrap gap-2">
              <NavPreview icon={<Briefcase className="h-4 w-4" strokeWidth={1.75} />}>
                {labels.labelJobPlural || "Jobs"}
              </NavPreview>
              <NavPreview icon={<FileText className="h-4 w-4" strokeWidth={1.75} />}>
                {labels.labelEstimatePlural || "Estimates"}
              </NavPreview>
              <NavPreview icon={<Users className="h-4 w-4" strokeWidth={1.75} />}>
                {labels.labelClientPlural || "Clients"}
              </NavPreview>
              <NavPreview icon={<Target className="h-4 w-4" strokeWidth={1.75} />}>
                {labels.labelLeadPlural || "Leads"}
              </NavPreview>
            </div>
            <p className="mt-3 text-xs text-ink-subtle">
              Invoices and payments keep their names. Those are the words a
              bank, an accountant and a customer all read the same way.
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

"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { createCatalogItem, updateCatalogItem } from "./actions";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import {
  Checkbox,
  Field,
  FormError,
  Input,
  Select,
  Textarea,
} from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  LINE_ITEM_KIND_LABELS,
  LINE_ITEM_KINDS,
  type LineItemKind,
} from "@/lib/constants";

export type CatalogFormValues = {
  id?: string;
  name: string;
  kind: LineItemKind;
  description: string;
  unit: string;
  price: string;
  taxable: boolean;
  isActive: boolean;
};

/** What each kind is for, so the choice is not four words with no guidance. */
const KIND_HINTS: Record<LineItemKind, string> = {
  SERVICE: "Work sold at a set price — a call-out, an install, a package.",
  MATERIAL: "Something bought and passed on — parts, fittings, supplies.",
  LABOR: "Time, usually priced by the hour or the day.",
  OTHER: "Anything else that belongs on an estimate or an invoice.",
};

export function CatalogForm({
  values,
  units,
  currencySymbol,
}: {
  values: CatalogFormValues;
  /** Units this business already uses, plus a few common ones. */
  units: string[];
  currencySymbol: string;
}) {
  const isEdit = Boolean(values.id);
  const [state, formAction] = useActionState<ActionState, FormData>(
    isEdit ? updateCatalogItem : createCatalogItem,
    IDLE,
  );

  // Every field is controlled, including the plain text ones.
  //
  // React resets an uncontrolled form once its action returns, and a reset
  // restores inputs to their defaults — so a refused submission would put the
  // stored values back and throw away what was typed, leaving "a price cannot
  // be negative" sitting under the old price. Holding the values here means a
  // reset restores what the person actually entered.
  const [kind, setKind] = useState<LineItemKind>(values.kind);
  const [name, setName] = useState(values.name);
  const [unit, setUnit] = useState(values.unit);
  const [price, setPrice] = useState(values.price);
  const [description, setDescription] = useState(values.description);
  const [taxable, setTaxable] = useState(values.taxable);
  const [isActive, setIsActive] = useState(values.isActive);

  const err = (key: string) => state.fieldErrors?.[key];

  return (
    <form action={formAction}>
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <Card>
        <CardHeader
          title={isEdit ? "Item details" : "New item"}
          description="What it is called on a document, and what it costs by default."
        />

        <CardBody className="space-y-5">
          <FormError>{state.error}</FormError>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Name"
              htmlFor="name"
              required
              error={err("name")}
              className="sm:col-span-2"
              hint="This is the wording the client reads on the estimate."
            >
              <Input
                id="name"
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus={!isEdit}
                placeholder="Annual boiler service"
              />
            </Field>

            <Field label="Kind" htmlFor="kind" hint={KIND_HINTS[kind]}>
              <Select
                id="kind"
                name="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as LineItemKind)}
              >
                {LINE_ITEM_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {LINE_ITEM_KIND_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Unit"
              htmlFor="unit"
              error={err("unit")}
              hint="What one of it is. Blank means each."
            >
              <Input
                id="unit"
                name="unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                list="catalog-units"
                placeholder="ea"
              />
              <datalist id="catalog-units">
                {units.map((unit) => (
                  <option key={unit} value={unit} />
                ))}
              </datalist>
            </Field>

            <Field
              label="Price per unit"
              htmlFor="price"
              error={err("price")}
              hint="The starting figure. Any document can change it."
            >
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-subtle">
                  {currencySymbol}
                </span>
                <Input
                  id="price"
                  name="price"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  className="tabular pl-7"
                />
              </div>
            </Field>

            <Field
              label="Description"
              htmlFor="description"
              className="sm:col-span-2"
              hint="Optional. Carried onto the line when this is picked."
            >
              <Textarea
                id="description"
                name="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Full inspection, clean and safety check. Parts extra."
              />
            </Field>
          </div>

          <div className="space-y-3 border-t border-line pt-5">
            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox
                name="taxable"
                checked={taxable}
                onChange={(e) => setTaxable(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium text-ink">
                  Taxable
                </span>
                <span className="mt-0.5 block text-xs text-ink-subtle">
                  Included when a document works out tax. Turn it off for
                  anything zero-rated or exempt.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox
                name="isActive"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium text-ink">
                  Offer it on estimates and invoices
                </span>
                <span className="mt-0.5 block text-xs text-ink-subtle">
                  Turn it off to archive: it stops being offered, and every
                  document already priced with it is untouched.
                </span>
              </span>
            </label>
          </div>
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <Link href="/catalog" className={buttonClasses("ghost", "md")}>
            Cancel
          </Link>
          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Adding…"}>
            {isEdit ? "Save changes" : "Add to catalog"}
          </SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

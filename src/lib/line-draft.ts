import type { LineItemKind } from "./constants";

/**
 * The editable shape of a document line before it is saved.
 *
 * Lives outside the editor component because server components build the
 * initial value, and a function exported from a `"use client"` module cannot be
 * *called* on the server — only referenced as a client entry point.
 *
 * Numbers are held as strings so a half-typed "1." or "12." is not snapped to a
 * number mid-keystroke; they are parsed once on submit.
 */
export type LineDraft = {
  key: string;
  kind: LineItemKind;
  name: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxable: boolean;
};

export function blankLine(kind: LineItemKind = "SERVICE"): LineDraft {
  return {
    key: `new-${Math.random().toString(36).slice(2)}`,
    kind,
    name: "",
    description: "",
    quantity: "1",
    unit: "ea",
    unitPrice: "",
    // Labor is commonly not taxable; the box is still there to change.
    taxable: kind !== "LABOR",
  };
}

/** Turns a saved line item back into an editable draft. */
export function lineToDraft(item: {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  taxable: boolean;
}): LineDraft {
  return {
    key: item.id,
    kind: item.kind as LineItemKind,
    name: item.name,
    description: item.description ?? "",
    quantity: String(item.quantity),
    unit: item.unit,
    unitPrice: (item.unitPriceCents / 100).toFixed(2),
    taxable: item.taxable,
  };
}

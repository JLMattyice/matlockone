"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";

import { Checkbox, Input, Select } from "@/components/ui/form";
import {
  LINE_ITEM_KIND_LABELS,
  LINE_ITEM_KINDS,
  type DiscountType,
  type LineItemKind,
} from "@/lib/constants";
import { blankLine, type LineDraft } from "@/lib/line-draft";
import {
  computeTotals,
  formatMoney,
  parseMoneyToCents,
  parseRateToBp,
} from "@/lib/money";
import { cn } from "@/lib/utils";

export type PriceBookOption = {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  unit: string;
  unitPriceCents: number;
  taxable: boolean;
};

function toNumber(value: string) {
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function LineItemEditor({
  initialLines,
  priceBook,
  currency,
  locale,
  currencySymbol,
  initialDiscountType,
  initialDiscountValue,
  initialTaxRate,
  taxExemptClient,
}: {
  initialLines: LineDraft[];
  priceBook: PriceBookOption[];
  currency: string;
  locale: string;
  currencySymbol: string;
  initialDiscountType: DiscountType;
  /** Percent as "10", or a money string for a fixed amount. */
  initialDiscountValue: string;
  /** Percent, e.g. "7.25". */
  initialTaxRate: string;
  taxExemptClient: boolean;
}) {
  const [lines, setLines] = useState<LineDraft[]>(
    initialLines.length ? initialLines : [blankLine()],
  );
  const [discountType, setDiscountType] =
    useState<DiscountType>(initialDiscountType);
  const [discountValue, setDiscountValue] = useState(initialDiscountValue);
  const [taxRate, setTaxRate] = useState(
    taxExemptClient ? "0" : initialTaxRate,
  );

  function update(key: string, patch: Partial<LineDraft>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function remove(key: string) {
    setLines((current) => {
      const next = current.filter((line) => line.key !== key);
      return next.length ? next : [blankLine()];
    });
  }

  function move(index: number, direction: -1 | 1) {
    setLines((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addFromPriceBook(id: string) {
    const entry = priceBook.find((item) => item.id === id);
    if (!entry) return;

    setLines((current) => [
      ...current.filter((line) => line.name.trim() !== "" || line.unitPrice !== ""),
      {
        ...blankLine(entry.kind as LineItemKind),
        name: entry.name,
        description: entry.description ?? "",
        unit: entry.unit,
        unitPrice: (entry.unitPriceCents / 100).toFixed(2),
        taxable: entry.taxable,
      },
    ]);
  }

  // The same arithmetic the server runs on submit — this is feedback only.
  const { totals, discountBpOrCents, taxRateBp, serialized } = useMemo(() => {
    const parsed = lines
      .filter((line) => line.name.trim() !== "")
      .map((line) => ({
        kind: line.kind,
        name: line.name.trim(),
        description: line.description.trim() || null,
        quantity: toNumber(line.quantity),
        unit: line.unit.trim() || "ea",
        unitPriceCents: parseMoneyToCents(line.unitPrice) ?? 0,
        taxable: line.taxable,
      }));

    const discountRaw =
      discountType === "PERCENT"
        ? (parseRateToBp(discountValue) ?? 0)
        : discountType === "FIXED"
          ? (parseMoneyToCents(discountValue) ?? 0)
          : 0;

    const rateBp = parseRateToBp(taxRate) ?? 0;

    return {
      totals: computeTotals({
        lineItems: parsed.map((line) => ({
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          taxable: line.taxable,
        })),
        discountType,
        discountValue: discountRaw,
        taxRateBp: rateBp,
      }),
      discountBpOrCents: discountRaw,
      taxRateBp: rateBp,
      serialized: JSON.stringify(parsed),
    };
  }, [lines, discountType, discountValue, taxRate]);

  const money = (cents: number) => formatMoney(cents, currency, locale);
  const lineTotal = (line: LineDraft) =>
    Math.round(toNumber(line.quantity) * (parseMoneyToCents(line.unitPrice) ?? 0));

  return (
    <div className="space-y-4">
      <input type="hidden" name="lineItemsJson" value={serialized} />
      <input type="hidden" name="discountType" value={discountType} />
      <input type="hidden" name="discountValue" value={discountBpOrCents} />
      <input type="hidden" name="taxRateBp" value={taxRateBp} />

      {/* ------------------------------------------------------- the lines --- */}
      <div className="space-y-2">
        <div className="hidden gap-2 px-1 text-xs font-semibold tracking-wide text-ink-subtle uppercase lg:grid lg:grid-cols-[7rem_minmax(0,1fr)_4.5rem_4rem_7rem_4rem_5.5rem_2rem]">
          <span>Type</span>
          <span>Description</span>
          <span className="text-right">Qty</span>
          <span>Unit</span>
          <span className="text-right">Price</span>
          <span className="text-center">Tax</span>
          <span className="text-right">Total</span>
          <span />
        </div>

        {lines.map((line, index) => (
          <div
            key={line.key}
            className="grid gap-2 rounded-lg border border-line bg-surface-2 p-2 lg:grid-cols-[7rem_minmax(0,1fr)_4.5rem_4rem_7rem_4rem_5.5rem_2rem] lg:items-start lg:border-0 lg:bg-transparent lg:p-1"
          >
            <Select
              value={line.kind}
              onChange={(e) =>
                update(line.key, { kind: e.target.value as LineItemKind })
              }
              aria-label={`Line ${index + 1} type`}
            >
              {LINE_ITEM_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {LINE_ITEM_KIND_LABELS[kind]}
                </option>
              ))}
            </Select>

            <div className="space-y-1">
              <Input
                value={line.name}
                onChange={(e) => update(line.key, { name: e.target.value })}
                placeholder="What is being charged for"
                aria-label={`Line ${index + 1} description`}
              />
              {line.description || line.name ? (
                <Input
                  value={line.description}
                  onChange={(e) =>
                    update(line.key, { description: e.target.value })
                  }
                  placeholder="Extra detail (optional)"
                  aria-label={`Line ${index + 1} detail`}
                  className="h-8 text-xs"
                />
              ) : null}
            </div>

            <Input
              value={line.quantity}
              onChange={(e) => update(line.key, { quantity: e.target.value })}
              inputMode="decimal"
              aria-label={`Line ${index + 1} quantity`}
              className="tabular text-right"
            />

            <Input
              value={line.unit}
              onChange={(e) => update(line.key, { unit: e.target.value })}
              aria-label={`Line ${index + 1} unit`}
            />

            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-ink-subtle">
                {currencySymbol}
              </span>
              <Input
                value={line.unitPrice}
                onChange={(e) => update(line.key, { unitPrice: e.target.value })}
                inputMode="decimal"
                placeholder="0.00"
                aria-label={`Line ${index + 1} unit price`}
                className="tabular pl-6 text-right"
              />
            </div>

            <label className="flex h-9.5 items-center justify-center gap-1.5 text-xs text-ink-muted">
              <Checkbox
                checked={line.taxable}
                onChange={(e) => update(line.key, { taxable: e.target.checked })}
                aria-label={`Line ${index + 1} taxable`}
              />
              <span className="lg:hidden">Taxable</span>
            </label>

            <span className="tabular flex h-9.5 items-center justify-end text-sm font-medium text-ink">
              {money(lineTotal(line))}
            </span>

            <div className="flex items-center justify-end gap-0.5">
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={`Move line ${index + 1} up`}
                className="flex h-6 w-5 items-center justify-center rounded text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === lines.length - 1}
                aria-label={`Move line ${index + 1} down`}
                className="flex h-6 w-5 items-center justify-center rounded text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-30"
              >
                <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
              <button
                type="button"
                onClick={() => remove(line.key)}
                aria-label={`Remove line ${index + 1}`}
                className="flex h-6 w-6 items-center justify-center rounded text-ink-subtle transition-colors hover:bg-danger/10 hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setLines((current) => [...current, blankLine()])}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-sm text-ink transition-colors hover:bg-surface-3"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          Add line
        </button>

        {priceBook.length > 0 ? (
          <Select
            value=""
            onChange={(e) => {
              addFromPriceBook(e.target.value);
              e.target.value = "";
            }}
            aria-label="Add from price book"
            className="w-56"
          >
            <option value="">Add from price book…</option>
            {priceBook.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} — {money(entry.unitPriceCents)}
              </option>
            ))}
          </Select>
        ) : null}
      </div>

      {/* ---------------------------------------------------------- totals --- */}
      <div className="flex justify-end">
        <dl className="w-full max-w-sm space-y-2 rounded-card border border-line bg-surface-2 p-4 text-sm">
          <Row label="Subtotal">{money(totals.subtotalCents)}</Row>

          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-2 text-ink-muted">
              <span>Discount</span>
              <Select
                value={discountType}
                onChange={(e) =>
                  setDiscountType(e.target.value as DiscountType)
                }
                aria-label="Discount type"
                className="h-7 w-24 text-xs"
              >
                <option value="NONE">None</option>
                <option value="PERCENT">Percent</option>
                <option value="FIXED">Amount</option>
              </Select>
              {discountType !== "NONE" ? (
                <Input
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  inputMode="decimal"
                  aria-label="Discount value"
                  className="tabular h-7 w-20 text-right text-xs"
                  placeholder={discountType === "PERCENT" ? "10" : "50.00"}
                />
              ) : null}
            </dt>
            <dd className="tabular font-medium text-ink">
              {totals.discountCents > 0 ? `−${money(totals.discountCents)}` : "—"}
            </dd>
          </div>

          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-2 text-ink-muted">
              <span>Tax</span>
              <Input
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                inputMode="decimal"
                aria-label="Tax rate percent"
                disabled={taxExemptClient}
                className="tabular h-7 w-16 text-right text-xs"
              />
              <span className="text-xs text-ink-subtle">%</span>
            </dt>
            <dd className="tabular font-medium text-ink">
              {money(totals.taxCents)}
            </dd>
          </div>

          {taxExemptClient ? (
            <p className="text-xs text-info">
              This client is marked tax exempt.
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-3 border-t border-line pt-2">
            <dt className="font-semibold text-ink">Total</dt>
            <dd
              className={cn(
                "tabular text-lg font-semibold",
                totals.totalCents < 0 ? "text-danger" : "text-ink",
              )}
            >
              {money(totals.totalCents)}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular font-medium text-ink">{children}</dd>
    </div>
  );
}

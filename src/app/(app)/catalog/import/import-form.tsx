"use client";

import { useMemo, useState, useTransition } from "react";

import { importCatalogItems, type CatalogImportResult } from "./actions";
import {
  ColumnMatcher,
  count,
  CsvFileBar,
  CsvFilePicker,
  ImportDone,
  LineList,
  skippedSentences,
  type LoadedCsv,
} from "@/components/import/csv-import";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { FormError, Label, Select } from "@/components/ui/form";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import {
  CATALOG_IMPORT_FIELDS,
  guessCatalogMapping,
  planCatalogImport,
  type CatalogMapping,
} from "@/lib/catalog-import";
import {
  LINE_ITEM_KIND_LABELS,
  LINE_ITEM_KINDS,
  type LineItemKind,
} from "@/lib/constants";
import { formatMoney } from "@/lib/money";

type Done = Extract<CatalogImportResult, { ok: true }>;

const PREVIEW_ROWS = 8;

const SOURCES = [
  { app: "Excel", steps: "File → Save As → “CSV UTF-8”." },
  { app: "Google Sheets", steps: "File → Download → Comma-separated values." },
  {
    app: "QuickBooks Online",
    steps: "Sales → Products and services → Export, then save that as CSV.",
  },
  { app: "A supplier or another app", steps: "look for “Export price list” or “Export items”." },
];

/**
 * Choose a price list, check the columns, see what will happen, import —
 * the same steps as the customer import, read the same way in the browser
 * and decided again on the server.
 */
export function CatalogImport({
  onFileNames,
  currency,
  locale,
}: {
  onFileNames: string[];
  currency: string;
  locale: string;
}) {
  const [file, setFile] = useState<LoadedCsv | null>(null);
  const [mapping, setMapping] = useState<CatalogMapping>([]);
  const [defaultKind, setDefaultKind] = useState<LineItemKind>("SERVICE");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [pending, startTransition] = useTransition();

  const plan = useMemo(
    () => (file ? planCatalogImport(file.table, mapping, onFileNames, defaultKind) : null),
    [file, mapping, onFileNames, defaultKind],
  );

  const money = (cents: number) => formatMoney(cents, currency, locale);

  function load(loaded: LoadedCsv) {
    setDone(null);
    setError(null);
    setFile(loaded);
    setMapping(guessCatalogMapping(loaded.table[0]));
  }

  function reset() {
    setFile(null);
    setMapping([]);
    setError(null);
  }

  function runImport() {
    if (!file) return;
    setError(null);
    startTransition(async () => {
      try {
        const outcome = await importCatalogItems(file.text, mapping, defaultKind);
        if (outcome.ok) {
          setDone(outcome);
          reset();
        } else {
          setError(outcome.error);
        }
      } catch {
        setError(
          "The import did not finish. Try again — any items it had already added will be recognised and skipped.",
        );
      }
    });
  }

  if (done) {
    return (
      <ImportDone
        title={
          done.created > 0
            ? `${count(done.created, "item", "items")} added to the price book`
            : "No new items to import"
        }
        lines={skippedSentences(done, "the price book")}
        href="/catalog"
        hrefLabel="View products & services"
        onAgain={() => setDone(null)}
      />
    );
  }

  if (!file || !plan) {
    return (
      <CsvFilePicker
        many="items"
        templateHref="/catalog/import/template"
        templateHint="Download the template, fill in one product or service per row, save it as CSV and bring it back here."
        sources={SOURCES}
        onLoad={load}
      />
    );
  }

  const named = mapping.includes("name");
  const skipped = [...plan.unnamed, ...plan.onFile, ...plan.repeated].sort(
    (a, b) => a.line - b.line,
  );

  return (
    <div className="space-y-4">
      <CsvFileBar file={file} onReset={reset} disabled={pending} />

      <ColumnMatcher
        table={file.table}
        mapping={mapping}
        fields={CATALOG_IMPORT_FIELDS}
        onChange={setMapping}
        disabled={pending}
        problem={named ? null : "Choose the column that holds each item's name."}
      />

      {named ? (
        <Card>
          <CardHeader
            title="What will happen"
            description="Checked against the price book by name, so nothing is added twice."
          />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge tone="success">{count(plan.ready.length, "new item", "new items")}</Badge>
              {plan.onFile.length > 0 ? (
                <Badge>{count(plan.onFile.length, "already in the price book", "already in the price book")}</Badge>
              ) : null}
              {plan.repeated.length > 0 ? (
                <Badge>{count(plan.repeated.length, "repeat in the file", "repeats in the file")}</Badge>
              ) : null}
              {plan.unnamed.length > 0 ? (
                <Badge tone="warning">{count(plan.unnamed.length, "line with no name", "lines with no name")}</Badge>
              ) : null}
              {plan.warned.length > 0 ? (
                <Badge tone="warning">{count(plan.warned.length, "with something changed", "with something changed")}</Badge>
              ) : null}
            </div>

            {plan.defaulted > 0 ? (
              <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <Label htmlFor="default-kind" className="font-normal text-ink-muted">
                  {plan.defaulted === plan.ready.length
                    ? "The file does not say what kind each item is. File them all as:"
                    : `${count(plan.defaulted, "item does", "items do")} not say what kind ${plan.defaulted === 1 ? "it is" : "they are"}. File ${plan.defaulted === 1 ? "it" : "them"} as:`}
                </Label>
                <Select
                  id="default-kind"
                  value={defaultKind}
                  onChange={(e) => setDefaultKind(e.target.value as LineItemKind)}
                  disabled={pending}
                  className="sm:w-44"
                >
                  {LINE_ITEM_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {LINE_ITEM_KIND_LABELS[kind]}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}

            {plan.ready.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-line">
                <Table>
                  <THead>
                    <Th>Name</Th>
                    <Th className="hidden sm:table-cell">Kind</Th>
                    <Th>Price</Th>
                    <Th className="hidden md:table-cell">Taxable</Th>
                  </THead>
                  <TBody>
                    {plan.ready.slice(0, PREVIEW_ROWS).map(({ line, draft }) =>
                      draft ? (
                        <Tr key={line}>
                          <Td>
                            <span className="block truncate font-medium text-ink">{draft.name}</span>
                            {draft.description ? (
                              <span className="block max-w-xs truncate text-xs text-ink-subtle">
                                {draft.description}
                              </span>
                            ) : null}
                          </Td>
                          <Td className="hidden text-ink-muted sm:table-cell">
                            {LINE_ITEM_KIND_LABELS[draft.kind]}
                          </Td>
                          <Td className="tabular whitespace-nowrap text-ink-muted">
                            {money(draft.unitPriceCents)}
                            <span className="text-ink-subtle"> / {draft.unit}</span>
                          </Td>
                          <Td className="hidden text-ink-muted md:table-cell">
                            {draft.taxable ? "Yes" : "No"}
                          </Td>
                        </Tr>
                      ) : null,
                    )}
                  </TBody>
                </Table>
                {plan.ready.length > PREVIEW_ROWS ? (
                  <p className="border-t border-line bg-surface-2 px-4 py-2 text-xs text-ink-subtle">
                    and {count(plan.ready.length - PREVIEW_ROWS, "more item", "more items")}
                  </p>
                ) : null}
              </div>
            ) : null}

            <LineList
              title={`${count(skipped.length, "line", "lines")} will be skipped`}
              rows={skipped}
              describe={(row) =>
                row.skipped === "no-name"
                  ? "no name"
                  : row.skipped === "on-file"
                    ? `${row.draft?.name} is already in the price book`
                    : `${row.draft?.name} is on an earlier line`
              }
            />

            <LineList
              title={`${count(plan.warned.length, "line", "lines")} will come in with something changed`}
              rows={plan.warned}
              describe={(row) => `${row.draft?.name}: ${row.warnings.join(" ")}`}
            />

            <FormError>{error}</FormError>
          </CardBody>
          <CardFooter>
            <Button onClick={runImport} disabled={pending || plan.ready.length === 0}>
              {pending
                ? "Importing…"
                : plan.ready.length === 0
                  ? "No new items to import"
                  : `Import ${count(plan.ready.length, "item", "items")}`}
            </Button>
          </CardFooter>
        </Card>
      ) : null}
    </div>
  );
}

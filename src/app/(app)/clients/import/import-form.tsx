"use client";

import { useMemo, useState, useTransition } from "react";
import { Building2 } from "lucide-react";

import { importClients, type ImportResult } from "./actions";
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
import { FormError } from "@/components/ui/form";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import {
  IMPORT_FIELDS,
  guessMapping,
  mapsAName,
  planImport,
  type ColumnMapping,
} from "@/lib/client-import";
import { formatPhone } from "@/lib/utils";

type Done = Extract<ImportResult, { ok: true }>;

const PREVIEW_ROWS = 8;

const SOURCES = [
  { app: "Excel", steps: "File → Save As → “CSV UTF-8”." },
  { app: "Google Sheets", steps: "File → Download → Comma-separated values." },
  { app: "QuickBooks Online", steps: "Sales → Customers → Export, then save that as CSV." },
  { app: "Another app", steps: "look for “Export customers” or “Export clients”." },
];

/**
 * Choose a file, check the columns, see what will happen, import.
 *
 * Everything up to the last step happens in the browser: the file is read
 * here and the preview is the same rules the server applies, so the counts on
 * the button are the counts that land. Nothing is sent until Import.
 */
export function ClientImport({
  singular,
  plural,
  onFileKeys,
}: {
  singular: string;
  plural: string;
  onFileKeys: string[];
}) {
  const [file, setFile] = useState<LoadedCsv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [pending, startTransition] = useTransition();

  const one = singular.toLowerCase();
  const many = plural.toLowerCase();

  const keys = useMemo(() => new Set(onFileKeys), [onFileKeys]);
  const plan = useMemo(
    () => (file ? planImport(file.table, mapping, keys) : null),
    [file, mapping, keys],
  );

  function load(loaded: LoadedCsv) {
    setDone(null);
    setError(null);
    setFile(loaded);
    setMapping(guessMapping(loaded.table[0]));
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
        const outcome = await importClients(file.text, mapping);
        if (outcome.ok) {
          setDone(outcome);
          reset();
        } else {
          setError(outcome.error);
        }
      } catch {
        setError(
          `The import did not finish. Try again — any ${many} it had already added will be recognised and skipped.`,
        );
      }
    });
  }

  if (done) {
    return (
      <ImportDone
        title={
          done.created > 0
            ? `${count(done.created, one, many)} imported`
            : `No new ${many} to import`
        }
        lines={skippedSentences(done, "your list")}
        href="/clients?sort=newest"
        hrefLabel={`View ${many}`}
        onAgain={() => setDone(null)}
      />
    );
  }

  if (!file || !plan) {
    return (
      <CsvFilePicker
        many={many}
        templateHref="/clients/import/template"
        templateHint={`Download the template, fill in one ${one} per row, save it as CSV and bring it back here.`}
        sources={SOURCES}
        onLoad={load}
      />
    );
  }

  const named = mapsAName(mapping);
  const skipped = [...plan.unnamed, ...plan.onFile, ...plan.repeated].sort(
    (a, b) => a.line - b.line,
  );

  return (
    <div className="space-y-4">
      <CsvFileBar file={file} onReset={reset} disabled={pending} />

      <ColumnMatcher
        table={file.table}
        mapping={mapping}
        fields={IMPORT_FIELDS}
        onChange={setMapping}
        disabled={pending}
        problem={
          named
            ? null
            : "Choose the column that holds each name: Full name, First and Last name, or Company."
        }
      />

      {named ? (
        <Card>
          <CardHeader
            title="What will happen"
            description={`Checked against your ${many} on email, or on name and phone, so nobody is added twice.`}
          />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge tone="success">{count(plan.ready.length, `new ${one}`, `new ${many}`)}</Badge>
              {plan.onFile.length > 0 ? (
                <Badge>{count(plan.onFile.length, "already in your list", "already in your list")}</Badge>
              ) : null}
              {plan.repeated.length > 0 ? (
                <Badge>{count(plan.repeated.length, "repeat in the file", "repeats in the file")}</Badge>
              ) : null}
              {plan.unnamed.length > 0 ? (
                <Badge tone="warning">{count(plan.unnamed.length, "line with no name", "lines with no name")}</Badge>
              ) : null}
              {plan.warned.length > 0 ? (
                <Badge tone="warning">{count(plan.warned.length, "with something left off", "with something left off")}</Badge>
              ) : null}
            </div>

            {plan.ready.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-line">
                <Table>
                  <THead>
                    <Th>Name</Th>
                    <Th>Email</Th>
                    <Th className="hidden sm:table-cell">Phone</Th>
                    <Th className="hidden md:table-cell">Address</Th>
                  </THead>
                  <TBody>
                    {plan.ready.slice(0, PREVIEW_ROWS).map(({ line, draft }) =>
                      draft ? (
                        <Tr key={line}>
                          <Td>
                            <span className="flex items-center gap-1.5 font-medium text-ink">
                              {draft.type === "BUSINESS" ? (
                                <Building2
                                  className="h-3.5 w-3.5 shrink-0 text-ink-subtle"
                                  strokeWidth={1.75}
                                  aria-label="Business"
                                />
                              ) : null}
                              <span className="truncate">{draft.displayName}</span>
                            </span>
                            {draft.type === "BUSINESS" && (draft.firstName || draft.lastName) ? (
                              <span className="block truncate text-xs text-ink-subtle">
                                {[draft.firstName, draft.lastName].filter(Boolean).join(" ")}
                              </span>
                            ) : null}
                          </Td>
                          <Td className="text-ink-muted">{draft.email ?? "—"}</Td>
                          <Td className="tabular hidden text-ink-muted sm:table-cell">
                            {formatPhone(draft.phone ?? draft.mobilePhone) || "—"}
                          </Td>
                          <Td className="hidden text-ink-muted md:table-cell">
                            {draft.address
                              ? [draft.address.line1, draft.address.city]
                                  .filter(Boolean)
                                  .join(", ")
                              : "—"}
                          </Td>
                        </Tr>
                      ) : null,
                    )}
                  </TBody>
                </Table>
                {plan.ready.length > PREVIEW_ROWS ? (
                  <p className="border-t border-line bg-surface-2 px-4 py-2 text-xs text-ink-subtle">
                    and {count(plan.ready.length - PREVIEW_ROWS, `more ${one}`, `more ${many}`)}
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
                    ? `${row.draft?.displayName} is already in your list`
                    : `${row.draft?.displayName} is on an earlier line`
              }
            />

            <LineList
              title={`${count(plan.warned.length, "line", "lines")} will come in with something left off`}
              rows={plan.warned}
              describe={(row) => `${row.draft?.displayName}: ${row.warnings.join(" ")}`}
            />

            <FormError>{error}</FormError>
          </CardBody>
          <CardFooter>
            <Button onClick={runImport} disabled={pending || plan.ready.length === 0}>
              {pending
                ? "Importing…"
                : plan.ready.length === 0
                  ? `No new ${many} to import`
                  : `Import ${count(plan.ready.length, one, many)}`}
            </Button>
          </CardFooter>
        </Card>
      ) : null}
    </div>
  );
}

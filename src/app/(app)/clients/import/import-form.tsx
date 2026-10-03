"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { Building2, CheckCircle2, Download, FileSpreadsheet, Upload } from "lucide-react";

import { importClients, type ImportResult } from "./actions";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { FormError, Select } from "@/components/ui/form";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import {
  IMPORT_FIELDS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  guessMapping,
  mapsAName,
  planImport,
  type ColumnMapping,
  type ImportField,
  type ImportRow,
} from "@/lib/client-import";
import { decodeCsvBytes, parseCsv } from "@/lib/csv";
import { cn, formatPhone } from "@/lib/utils";

type Loaded = { name: string; text: string; table: string[][] };
type Done = Extract<ImportResult, { ok: true }>;

const PREVIEW_ROWS = 8;
const LISTED_LINES = 50;

function count(n: number, one: string, many: string) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

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
  const [file, setFile] = useState<Loaded | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const one = singular.toLowerCase();
  const many = plural.toLowerCase();

  const keys = useMemo(() => new Set(onFileKeys), [onFileKeys]);
  const plan = useMemo(
    () => (file ? planImport(file.table, mapping, keys) : null),
    [file, mapping, keys],
  );

  async function load(chosen: File | undefined) {
    setError(null);
    setDone(null);
    if (!chosen) return;

    if (/\.(xlsx|xls|xlsm|numbers|ods)$/i.test(chosen.name)) {
      setError(
        "That is a spreadsheet file rather than a CSV. Open it and save a copy as CSV first — the steps are below.",
      );
      return;
    }
    if (chosen.size > IMPORT_MAX_BYTES) {
      setError("That file is over 4 MB. Split the list into parts and import each one.");
      return;
    }

    const text = decodeCsvBytes(await chosen.arrayBuffer());
    const table = parseCsv(text);

    if (table.length < 2) {
      setError("That file has no rows under its column headings.");
      return;
    }
    if (table.length - 1 > IMPORT_MAX_ROWS) {
      setError(
        `That file has ${(table.length - 1).toLocaleString("en-US")} rows. Up to ${IMPORT_MAX_ROWS.toLocaleString("en-US")} can be imported at a time — split it into parts.`,
      );
      return;
    }

    setFile({ name: chosen.name, text, table });
    setMapping(guessMapping(table[0]));
  }

  function choose(column: number, field: ImportField | null) {
    setMapping((current) =>
      current.map((existing, i) => {
        if (i === column) return field;
        // One column per field: choosing it here takes it from wherever it was.
        return field && existing === field ? null : existing;
      }),
    );
  }

  function reset() {
    setFile(null);
    setMapping([]);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
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
      <Card>
        <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-success/10 text-success">
            <CheckCircle2 className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <div className="space-y-1">
            <p className="text-base font-semibold text-ink">
              {done.created > 0
                ? `${count(done.created, one, many)} imported`
                : `No new ${many} to import`}
            </p>
            {done.onFile > 0 ? (
              <p className="text-sm text-ink-muted">
                {count(done.onFile, "was", "were")} already in your list and left
                as {done.onFile === 1 ? "it was" : "they were"}.
              </p>
            ) : null}
            {done.repeated > 0 ? (
              <p className="text-sm text-ink-muted">
                {count(done.repeated, "line repeated", "lines repeated")} an
                earlier line and {done.repeated === 1 ? "was" : "were"} skipped.
              </p>
            ) : null}
            {done.unnamed > 0 ? (
              <p className="text-sm text-ink-muted">
                {count(done.unnamed, "line had", "lines had")} no name and{" "}
                {done.unnamed === 1 ? "was" : "were"} skipped.
              </p>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Link href="/clients?sort=newest" className={buttonClasses("primary", "md")}>
              View {many}
            </Link>
            <Button variant="outline" onClick={() => setDone(null)}>
              Import another file
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (!file || !plan) {
    return (
      <div className="space-y-4">
        <FormError>{error}</FormError>

        <Card>
          <CardHeader
            title="Choose your file"
            description="A CSV file with column headings in its first row."
          />
          <CardBody className="space-y-5">
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void load(e.dataTransfer.files[0]);
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-card border border-dashed px-4 py-10 text-center transition-colors",
                dragging
                  ? "border-brand bg-brand/5"
                  : "border-line-strong hover:border-brand hover:bg-surface-2",
              )}
            >
              <Upload className="h-5 w-5 text-ink-subtle" strokeWidth={1.75} />
              <span className="text-sm font-medium text-ink">
                Drop a CSV file here, or click to choose
              </span>
              <span className="text-xs text-ink-subtle">
                Up to {IMPORT_MAX_ROWS.toLocaleString("en-US")} {many} and 4 MB per file
              </span>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                className="sr-only"
                onChange={(e) => void load(e.target.files?.[0])}
              />
            </label>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-medium text-ink">Getting a CSV file</h3>
                <ul className="mt-2 space-y-1.5 text-sm text-ink-muted">
                  <li>
                    <span className="text-ink">Excel:</span> File → Save As →
                    “CSV UTF-8”.
                  </li>
                  <li>
                    <span className="text-ink">Google Sheets:</span> File →
                    Download → Comma-separated values.
                  </li>
                  <li>
                    <span className="text-ink">QuickBooks Online:</span> Sales →
                    Customers → Export, then save that as CSV.
                  </li>
                  <li>
                    <span className="text-ink">Another app:</span> look for
                    “Export customers” or “Export clients”.
                  </li>
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-medium text-ink">Starting from scratch?</h3>
                <p className="mt-2 text-sm text-ink-muted">
                  Download the template, fill in one {one} per row, save it as
                  CSV and bring it back here.
                </p>
                <a
                  href="/clients/import/template"
                  download
                  className={buttonClasses("outline", "sm", "mt-3")}
                >
                  <Download className="h-3.5 w-3.5" strokeWidth={2} />
                  Download template
                </a>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  const headings = file.table[0];
  const named = mapsAName(mapping);
  const sample = (column: number) =>
    file.table
      .slice(1, 21)
      .map((row) => (row[column] ?? "").trim())
      .find(Boolean) ?? "";

  const skippedLines = [...plan.unnamed, ...plan.onFile, ...plan.repeated].sort(
    (a, b) => a.line - b.line,
  );

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <FileSpreadsheet className="h-5 w-5 shrink-0 text-brand" strokeWidth={1.75} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{file.name}</p>
            <p className="text-xs text-ink-subtle">
              {count(file.table.length - 1, "row", "rows")} · {count(headings.length, "column", "columns")}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={reset} disabled={pending}>
          Choose a different file
        </Button>
      </Card>

      <Card>
        <CardHeader
          title="Match your columns"
          description="Guessed from your headings. Change any that are wrong — a column left out is not imported."
        />
        <div className="divide-y divide-line">
          {headings.map((heading, column) => (
            <div
              key={column}
              className="grid grid-cols-1 gap-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_14rem] sm:items-center sm:gap-4"
            >
              <p className="truncate text-sm font-medium text-ink">
                {heading.trim() || `Column ${column + 1}`}
              </p>
              <p className="truncate text-sm text-ink-subtle">
                {sample(column) || "—"}
              </p>
              <Select
                aria-label={`What “${heading.trim() || `Column ${column + 1}`}” holds`}
                value={mapping[column] ?? ""}
                onChange={(e) =>
                  choose(column, (e.target.value || null) as ImportField | null)
                }
                disabled={pending}
                className={cn(!mapping[column] && "text-ink-subtle")}
              >
                <option value="">Leave out</option>
                {IMPORT_FIELDS.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
        {!named ? (
          <div className="border-t border-line px-5 py-3">
            <p className="text-sm text-danger">
              Choose the column that holds each name: Full name, First and Last
              name, or Company.
            </p>
          </div>
        ) : null}
      </Card>

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

            {skippedLines.length > 0 ? (
              <LineList
                title={`${count(skippedLines.length, "line", "lines")} will be skipped`}
                rows={skippedLines}
                describe={(row) =>
                  row.skipped === "no-name"
                    ? "no name"
                    : row.skipped === "on-file"
                      ? `${row.draft?.displayName} is already in your list`
                      : `${row.draft?.displayName} is on an earlier line`
                }
              />
            ) : null}

            {plan.warned.length > 0 ? (
              <LineList
                title={`${count(plan.warned.length, "line", "lines")} will come in with something left off`}
                rows={plan.warned}
                describe={(row) => `${row.draft?.displayName}: ${row.warnings.join(" ")}`}
              />
            ) : null}

            <FormError>{error}</FormError>
          </CardBody>
          <CardFooter>
            <Button
              onClick={runImport}
              disabled={pending || plan.ready.length === 0}
            >
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

function LineList({
  title,
  rows,
  describe,
}: {
  title: string;
  rows: ImportRow[];
  describe: (row: ImportRow) => string;
}) {
  return (
    <details className="group rounded-lg border border-line">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-ink select-none">
        {title}
      </summary>
      <ul className="space-y-1 border-t border-line px-4 py-3 text-sm text-ink-muted">
        {rows.slice(0, LISTED_LINES).map((row) => (
          <li key={row.line}>
            <span className="tabular text-ink-subtle">Line {row.line}</span> —{" "}
            {describe(row)}
          </li>
        ))}
        {rows.length > LISTED_LINES ? (
          <li className="text-ink-subtle">
            and {count(rows.length - LISTED_LINES, "more", "more")}
          </li>
        ) : null}
      </ul>
    </details>
  );
}

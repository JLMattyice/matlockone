"use client";

import Link from "next/link";
import { useState } from "react";
import { CheckCircle2, Download, FileSpreadsheet, Upload } from "lucide-react";

import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, Select } from "@/components/ui/form";
import { decodeCsvBytes, parseCsv } from "@/lib/csv";
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  tableProblem,
  type Mapping,
} from "@/lib/import-columns";
import { cn } from "@/lib/utils";

/**
 * The screens every spreadsheet import shares: choosing the file, matching
 * its columns, listing the lines that will not come in, and the result. What
 * each import previews, and how it decides, is its own.
 */

export type LoadedCsv = { name: string; text: string; table: string[][] };

/** "1 client" / "12 clients". */
export function count(n: number, one: string, many: string) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * Where a file comes from and the drop zone to put it in. The file is read
 * here, in the browser — nothing is sent until the import itself.
 */
export function CsvFilePicker({
  many,
  templateHref,
  templateHint,
  sources,
  onLoad,
}: {
  /** What the rows are, plural and lowercase: "clients", "items". */
  many: string;
  templateHref: string;
  templateHint: string;
  /** "Excel" → "File → Save As → “CSV UTF-8”." */
  sources: { app: string; steps: string }[];
  onLoad: (file: LoadedCsv) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  async function load(chosen: File | undefined) {
    setError(null);
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
    const problem = tableProblem(table);
    if (problem) {
      setError(problem);
      return;
    }

    onLoad({ name: chosen.name, text, table });
  }

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
                {sources.map((source) => (
                  <li key={source.app}>
                    <span className="text-ink">{source.app}:</span> {source.steps}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-medium text-ink">Starting from scratch?</h3>
              <p className="mt-2 text-sm text-ink-muted">{templateHint}</p>
              <a
                href={templateHref}
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

/** The chosen file's name and size, with a way back to choosing another. */
export function CsvFileBar({
  file,
  onReset,
  disabled,
}: {
  file: LoadedCsv;
  onReset: () => void;
  disabled?: boolean;
}) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <FileSpreadsheet className="h-5 w-5 shrink-0 text-brand" strokeWidth={1.75} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{file.name}</p>
          <p className="text-xs text-ink-subtle">
            {count(file.table.length - 1, "row", "rows")} ·{" "}
            {count(file.table[0].length, "column", "columns")}
          </p>
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onReset} disabled={disabled}>
        Choose a different file
      </Button>
    </Card>
  );
}

/**
 * Each column of the file, an example of what it holds, and what it fills.
 * One column per field: choosing a field here takes it from wherever it was.
 */
export function ColumnMatcher<F extends string>({
  table,
  mapping,
  fields,
  onChange,
  disabled,
  problem,
}: {
  table: string[][];
  mapping: Mapping<F>;
  fields: readonly { key: F; label: string }[];
  onChange: (mapping: Mapping<F>) => void;
  disabled?: boolean;
  /** Shown under the columns while the choices cannot be imported. */
  problem?: string | null;
}) {
  const headings = table[0];
  const sample = (column: number) =>
    table
      .slice(1, 21)
      .map((row) => (row[column] ?? "").trim())
      .find(Boolean) ?? "";

  function choose(column: number, field: F | null) {
    onChange(
      mapping.map((existing, i) => {
        if (i === column) return field;
        return field && existing === field ? null : existing;
      }),
    );
  }

  return (
    <Card>
      <CardHeader
        title="Match your columns"
        description="Guessed from your headings. Change any that are wrong — a column left out is not imported."
      />
      <div className="divide-y divide-line">
        {headings.map((heading, column) => {
          const name = heading.trim() || `Column ${column + 1}`;
          return (
            <div
              key={column}
              className="grid grid-cols-1 gap-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_14rem] sm:items-center sm:gap-4"
            >
              <p className="truncate text-sm font-medium text-ink">{name}</p>
              <p className="truncate text-sm text-ink-subtle">{sample(column) || "—"}</p>
              <Select
                aria-label={`What “${name}” holds`}
                value={mapping[column] ?? ""}
                onChange={(e) => choose(column, (e.target.value || null) as F | null)}
                disabled={disabled}
                className={cn(!mapping[column] && "text-ink-subtle")}
              >
                <option value="">Leave out</option>
                {fields.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
              </Select>
            </div>
          );
        })}
      </div>
      {problem ? (
        <div className="border-t border-line px-5 py-3">
          <p className="text-sm text-danger">{problem}</p>
        </div>
      ) : null}
    </Card>
  );
}

const LISTED_LINES = 50;

/** A folded list of lines and what happens to each. */
export function LineList<R extends { line: number }>({
  title,
  rows,
  describe,
}: {
  title: string;
  rows: R[];
  describe: (row: R) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <details className="rounded-lg border border-line">
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

/** The sentences under an import's result, for whatever it skipped. */
export function skippedSentences(
  done: { onFile: number; repeated: number; unnamed: number },
  where: string,
): string[] {
  const lines: string[] = [];
  if (done.onFile > 0) {
    lines.push(
      `${count(done.onFile, "was", "were")} already in ${where} and left as ${done.onFile === 1 ? "it was" : "they were"}.`,
    );
  }
  if (done.repeated > 0) {
    lines.push(
      `${count(done.repeated, "line repeated", "lines repeated")} an earlier line and ${done.repeated === 1 ? "was" : "were"} skipped.`,
    );
  }
  if (done.unnamed > 0) {
    lines.push(
      `${count(done.unnamed, "line had", "lines had")} no name and ${done.unnamed === 1 ? "was" : "were"} skipped.`,
    );
  }
  return lines;
}

/** What an import did, and where to go next. */
export function ImportDone({
  title,
  lines,
  href,
  hrefLabel,
  onAgain,
}: {
  title: string;
  lines: string[];
  href: string;
  hrefLabel: string;
  onAgain: () => void;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle2 className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="space-y-1">
          <p className="text-base font-semibold text-ink">{title}</p>
          {lines.map((line) => (
            <p key={line} className="text-sm text-ink-muted">
              {line}
            </p>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Link href={href} className={buttonClasses("primary", "md")}>
            {hrefLabel}
          </Link>
          <Button variant="outline" onClick={onAgain}>
            Import another file
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

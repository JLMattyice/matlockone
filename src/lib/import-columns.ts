/**
 * What every spreadsheet import shares: the size limits, telling the columns
 * apart by their headings, and making the browser's column choices safe.
 *
 * Each import (customers, the price book) brings its own fields and its own
 * heading tables; the guessing and checking here is the same for all of them.
 * Plain code with no imports, because it runs in the browser too.
 */

/** The most a single file may hold. Larger lists import in parts. */
export const IMPORT_MAX_ROWS = 5000;

/**
 * The largest file accepted, in bytes. Vercel refuses a request body over
 * 4.5 MB before the code ever sees it, and the file travels as text.
 */
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;

/** For each column of the file, the field it fills, or null to leave it out. */
export type Mapping<F extends string> = (F | null)[];

/** "E-mail Address" → "e mail address": how headings are compared. */
export function normalizeHeading(heading: string) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Lowercase with runs of space collapsed, for comparing names. */
export function lowerSquash(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A first guess at what each column holds, from its heading.
 *
 * `exact` lists the headings that mean a field outright; `contains` is the
 * looser second pass for headings nothing exact took ("Main Phone #s"), tried
 * in order. Each field is taken by one column at most — the first to claim it.
 */
export function guessColumns<F extends string>(
  headings: string[],
  fields: readonly F[],
  exact: Record<F, string[]>,
  contains: [F, RegExp][],
): Mapping<F> {
  const mapping: Mapping<F> = headings.map(() => null);
  const taken = new Set<F>();
  const normalized = headings.map(normalizeHeading);

  normalized.forEach((heading, column) => {
    for (const field of fields) {
      if (!taken.has(field) && exact[field].includes(heading)) {
        mapping[column] = field;
        taken.add(field);
        return;
      }
    }
  });

  normalized.forEach((heading, column) => {
    if (mapping[column] || !heading) return;
    for (const [field, pattern] of contains) {
      if (!taken.has(field) && pattern.test(heading)) {
        mapping[column] = field;
        taken.add(field);
        return;
      }
    }
  });

  return mapping;
}

/**
 * The browser's column choices, made safe: one entry per column, each a known
 * field or nothing, and no field filled from two columns.
 */
export function sanitizeMapping<F extends string>(
  raw: unknown,
  columns: number,
  isField: (value: unknown) => value is F,
): Mapping<F> {
  const list = Array.isArray(raw) ? raw : [];
  const taken = new Set<F>();
  return Array.from({ length: columns }, (_, column) => {
    const field = list[column];
    if (!isField(field) || taken.has(field)) return null;
    taken.add(field);
    return field;
  });
}

/**
 * Why a parsed file cannot be imported at all, or null when it can. The
 * browser and the server both ask, so they refuse with the same words.
 */
export function tableProblem(table: string[][]): string | null {
  if (table.length < 2) return "That file has no rows under its column headings.";
  if (table.length - 1 > IMPORT_MAX_ROWS) {
    return `That file has ${(table.length - 1).toLocaleString("en-US")} rows. Up to ${IMPORT_MAX_ROWS.toLocaleString("en-US")} can be imported at a time — split it into parts.`;
  }
  return null;
}

/** Inserts go in groups, well inside every database's limit on one statement. */
export function inGroups<T>(items: T[], size = 500): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

/** "Yes", "x", "TRUE" → true; "No", "0" → false; anything else → null. */
export function readYesNo(value: string): boolean | null {
  const text = value.trim().toLowerCase();
  if (/^(y|yes|true|1|x|✓|✔)$/.test(text)) return true;
  if (/^(n|no|false|0|-)$/.test(text)) return false;
  return null;
}

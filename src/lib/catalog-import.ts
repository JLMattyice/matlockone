import { LINE_ITEM_KIND_LABELS, LINE_ITEM_KINDS, type LineItemKind } from "./constants";
import { guessColumns, lowerSquash, readYesNo, type Mapping } from "./import-columns";
import { parseMoneyToCents } from "./money";

/**
 * Turning a price list somebody already has into the price book.
 *
 * Like the customer import, the rules run twice — in the browser for the
 * preview, and on the server, which decides for itself — so nothing here
 * touches the database. The items already in the price book come in as names.
 *
 * Price lists are messier than customer lists in one particular way: the
 * price column holds whatever people type, "$85/yd" or "call for quote". A
 * price that cannot be read is brought in at 0 and said so in the preview,
 * because 0 is already how the price book keeps something priced per job.
 */

export const CATALOG_IMPORT_FIELDS = [
  { key: "name", label: "Name" },
  { key: "kind", label: "Kind (service, material…)" },
  { key: "description", label: "Description" },
  { key: "unit", label: "Unit" },
  { key: "price", label: "Price" },
  { key: "taxable", label: "Taxable" },
] as const;

export type CatalogImportField = (typeof CATALOG_IMPORT_FIELDS)[number]["key"];

const FIELD_KEYS = new Set<string>(CATALOG_IMPORT_FIELDS.map((field) => field.key));

export function isCatalogImportField(value: unknown): value is CatalogImportField {
  return typeof value === "string" && FIELD_KEYS.has(value);
}

export type CatalogMapping = Mapping<CatalogImportField>;

/** The catalog form's own limit on a unit. */
const MAX_UNIT_LENGTH = 16;

const EXACT: Record<CatalogImportField, string[]> = {
  name: [
    "name", "item", "item name", "product", "product name", "service",
    "service name", "product service", "product service name", "title",
  ],
  kind: ["kind", "type", "item type", "product type", "service type"],
  description: [
    "description", "sales description", "item description", "details",
    "long description",
  ],
  unit: [
    "unit", "units", "uom", "unit of measure", "unit of measurement", "per",
    "measure",
  ],
  price: [
    "price", "rate", "unit price", "sales price", "sales price rate",
    "sale price", "selling price", "list price", "default price",
    "price each", "retail price", "amount",
  ],
  taxable: ["taxable", "tax", "is taxable", "sales tax", "taxed"],
};

/** Order matters: "Unit Price (USD)" is a price before it is a unit. */
const CONTAINS: [CatalogImportField, RegExp][] = [
  ["price", /\b(price|rate)\b/],
  ["description", /\bdescription\b/],
  ["unit", /\b(unit|uom)\b/],
  ["taxable", /\btax/],
  ["kind", /\btype\b/],
  ["name", /\bname\b/],
];

/** A first guess at what each column holds, from its heading. */
export function guessCatalogMapping(headings: string[]): CatalogMapping {
  return guessColumns(
    headings,
    CATALOG_IMPORT_FIELDS.map((field) => field.key),
    EXACT,
    CONTAINS,
  );
}

export function isLineItemKindValue(value: unknown): value is LineItemKind {
  return typeof value === "string" && (LINE_ITEM_KINDS as readonly string[]).includes(value);
}

/**
 * A spreadsheet's word for the kind, as one of the price book's four.
 * QuickBooks says Service, Inventory, Non-inventory or Bundle.
 */
function readKind(value: string): LineItemKind | null {
  const text = lowerSquash(value.replace(/[_-]/g, " "));
  if (/(labou?r|hourly|\bhours?\b|\btime\b)/.test(text)) return "LABOR";
  if (/service/.test(text)) return "SERVICE";
  if (/(inventory|product|material|part|goods|suppl|equipment|stock)/.test(text)) return "MATERIAL";
  if (/(other|bundle|fee|charge|misc)/.test(text)) return "OTHER";
  return null;
}

/** "$85/yd" or "85 per yard" → the amount and the unit; otherwise just the amount. */
function splitPrice(cell: string): { amount: string; unit: string | null } {
  const per = /^(.*?\d.*?)\s*(?:\/|\bper\b)\s*([a-z][a-z .]*)$/i.exec(cell.trim());
  return per ? { amount: per[1], unit: per[2].trim() } : { amount: cell, unit: null };
}

/** One item as it will be saved. */
export type CatalogDraft = {
  name: string;
  kind: LineItemKind;
  /** True when the file did not say, and the kind chosen on the page was used. */
  kindDefaulted: boolean;
  description: string | null;
  unit: string;
  unitPriceCents: number;
  taxable: boolean;
};

export type CatalogImportRow = {
  /** The line number a spreadsheet would show — the headings are line 1. */
  line: number;
  draft: CatalogDraft | null;
  skipped: "no-name" | "on-file" | "repeated" | null;
  warnings: string[];
};

export type CatalogImportPlan = {
  rows: CatalogImportRow[];
  ready: CatalogImportRow[];
  onFile: CatalogImportRow[];
  repeated: CatalogImportRow[];
  unnamed: CatalogImportRow[];
  warned: CatalogImportRow[];
  /** How many ready items take the page's kind because the file gave none. */
  defaulted: number;
};

/** How an item is recognised as already being in the price book: its name. */
export function catalogMatchKey(name: string) {
  return lowerSquash(name);
}

function readLine(
  cells: string[],
  mapping: CatalogMapping,
  defaultKind: LineItemKind,
): { draft: CatalogDraft | null; warnings: string[] } {
  const value = (field: CatalogImportField): string | null => {
    const column = mapping.indexOf(field);
    if (column < 0) return null;
    const cell = (cells[column] ?? "").trim();
    return cell === "" ? null : cell;
  };

  const warnings: string[] = [];
  const name = value("name");
  if (!name) return { draft: null, warnings };

  let kind = defaultKind;
  let kindDefaulted = true;
  const kindCell = value("kind");
  if (kindCell) {
    const read = readKind(kindCell);
    if (read) {
      kind = read;
      kindDefaulted = false;
    } else {
      warnings.push(
        `“${kindCell}” is not a kind Matlock One knows, so it was filed as ${LINE_ITEM_KIND_LABELS[defaultKind]}.`,
      );
    }
  }

  let unitPriceCents = 0;
  let unitFromPrice: string | null = null;
  const priceCell = value("price");
  if (priceCell) {
    const { amount, unit } = splitPrice(priceCell);
    const cents = parseMoneyToCents(amount);
    if (cents == null || cents < 0) {
      warnings.push(`“${priceCell}” is not a price, so it was set to 0.`);
    } else {
      unitPriceCents = cents;
      unitFromPrice = unit;
    }
  }

  let unit = value("unit") ?? unitFromPrice ?? "ea";
  if (unit.length > MAX_UNIT_LENGTH) {
    warnings.push(`The unit “${unit}” is too long for a unit, so it was set to ea.`);
    unit = "ea";
  }

  let taxable = true;
  const taxCell = value("taxable");
  if (taxCell) {
    const yes = readYesNo(taxCell);
    if (yes != null) taxable = yes;
    else if (/(non|exempt|not|untaxed)/i.test(taxCell)) taxable = false;
    else if (!/tax/i.test(taxCell)) {
      warnings.push(`“${taxCell}” is not yes or no, so it was marked taxable.`);
    }
  }

  return {
    draft: {
      name,
      kind,
      kindDefaulted,
      description: value("description"),
      unit,
      unitPriceCents,
      taxable,
    },
    warnings,
  };
}

/**
 * Every line of the file, decided: imported, already in the price book,
 * repeated, or missing a name. `table` includes the headings as its first row.
 */
export function planCatalogImport(
  table: string[][],
  mapping: CatalogMapping,
  onFileNames: Iterable<string>,
  defaultKind: LineItemKind,
): CatalogImportPlan {
  const onFile = new Set([...onFileNames].map(catalogMatchKey));
  const inFile = new Set<string>();
  const rows: CatalogImportRow[] = [];

  table.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const { draft, warnings } = readLine(cells, mapping, defaultKind);

    if (!draft) {
      rows.push({ line, draft: null, skipped: "no-name", warnings: [] });
      return;
    }

    const key = catalogMatchKey(draft.name);
    if (onFile.has(key)) {
      rows.push({ line, draft, skipped: "on-file", warnings: [] });
      return;
    }
    if (inFile.has(key)) {
      rows.push({ line, draft, skipped: "repeated", warnings: [] });
      return;
    }

    inFile.add(key);
    rows.push({ line, draft, skipped: null, warnings });
  });

  const ready = rows.filter((row) => !row.skipped);
  return {
    rows,
    ready,
    onFile: rows.filter((row) => row.skipped === "on-file"),
    repeated: rows.filter((row) => row.skipped === "repeated"),
    unnamed: rows.filter((row) => row.skipped === "no-name"),
    warned: ready.filter((row) => row.warnings.length > 0),
    defaulted: ready.filter((row) => row.draft?.kindDefaulted).length,
  };
}

/** The headings and example lines of the downloadable template. */
export const CATALOG_IMPORT_TEMPLATE: string[][] = [
  ["Name", "Kind", "Description", "Unit", "Price", "Taxable"],
  ["Service call", "Service", "Trip charge and the first half hour on site", "ea", "125.00", "No"],
  ["Lawn mowing", "Service", "Front and back, up to a quarter acre", "visit", "65.00", "No"],
  ["Hardwood mulch", "Material", "Delivered and spread", "yd", "85.00", "Yes"],
  ["Labor", "Labor", "", "hr", "75.00", "No"],
];

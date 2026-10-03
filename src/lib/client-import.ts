import { z } from "zod";

import { LEAD_SOURCES, type ClientType, type LeadSource } from "./constants";

/**
 * Turning a customer list somebody already has into customers here.
 *
 * The rules live in one place and run twice: in the browser, so the preview
 * says exactly what will happen before anything is saved, and on the server,
 * which reads the file again and decides for itself. No database here — the
 * caller hands in the customers already on file as match keys.
 *
 * What it has to cope with is whatever a small business has: an Excel sheet
 * with "Name" in one column, a QuickBooks export where "Customer" and
 * "Company" are often the same thing, another app's "Main phone #s". So the
 * columns are guessed from their headings and the owner corrects the guess,
 * rather than the file having to match a template.
 */

/** The most a single file may hold. Larger lists import in parts. */
export const IMPORT_MAX_ROWS = 5000;

/**
 * The largest file accepted, in bytes. Vercel refuses a request body over
 * 4.5 MB before the code ever sees it, and the file travels as text.
 */
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;

export const IMPORT_FIELDS = [
  { key: "fullName", label: "Full name" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "businessName", label: "Company / business name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "mobilePhone", label: "Mobile phone" },
  { key: "website", label: "Website" },
  { key: "line1", label: "Street address" },
  { key: "line2", label: "Address line 2" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "postalCode", label: "ZIP / postal code" },
  { key: "source", label: "How they found you" },
  { key: "taxExempt", label: "Tax exempt" },
  { key: "notes", label: "Notes" },
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number]["key"];

const FIELD_KEYS = new Set<string>(IMPORT_FIELDS.map((field) => field.key));

export function isImportField(value: unknown): value is ImportField {
  return typeof value === "string" && FIELD_KEYS.has(value);
}

/** For each column of the file, the field it fills, or null to leave it out. */
export type ColumnMapping = (ImportField | null)[];

/** "E-mail Address" → "e mail address": how headings are compared. */
function normalizeHeading(heading: string) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Headings that mean a field outright, after normalizing. */
const EXACT: Record<ImportField, string[]> = {
  fullName: [
    "name", "full name", "customer", "customer name", "client", "client name",
    "contact", "contact name", "display name", "patient", "patient name",
    "student", "student name", "member", "member name",
  ],
  firstName: ["first name", "first", "firstname", "given name", "fname"],
  lastName: ["last name", "last", "lastname", "surname", "family name", "lname"],
  businessName: [
    "company", "company name", "business", "business name", "organization",
    "organisation", "organization name", "employer",
  ],
  email: [
    "email", "e mail", "email address", "e mail address", "main email",
    "primary email", "emails",
  ],
  phone: [
    "phone", "phone number", "telephone", "tel", "main phone", "primary phone",
    "home phone", "work phone", "business phone", "phones", "phone 1",
  ],
  mobilePhone: [
    "mobile", "mobile phone", "mobile number", "cell", "cell phone",
    "cell number", "cellphone",
  ],
  website: ["website", "web site", "url", "web", "web address", "site"],
  line1: [
    "street", "street address", "address", "address 1", "address line 1",
    "street 1", "street address 1", "billing street", "billing address",
    "billing address line 1", "service address", "property address",
    "mailing address",
  ],
  line2: [
    "address 2", "address line 2", "street 2", "street address 2",
    "billing address line 2", "apt", "apartment", "suite", "unit",
  ],
  city: ["city", "town", "billing city", "city town", "mailing city"],
  state: [
    "state", "province", "region", "state province", "billing state", "st",
    "mailing state",
  ],
  postalCode: [
    "zip", "zip code", "zipcode", "postal code", "postcode", "post code",
    "billing zip", "billing zip code", "billing postal code",
    "zip postal code", "mailing zip",
  ],
  source: [
    "source", "lead source", "referral source", "how did you hear about us",
    "how they found you", "how did they find you", "found us",
  ],
  taxExempt: ["tax exempt", "tax exempt status", "exempt"],
  notes: ["notes", "note", "comments", "comment", "memo", "details"],
};

/**
 * Looser rules for headings no exact match took — "Main Phone #s", "Billing
 * Address City". Order matters: mobile before phone, so "Mobile phone" is not
 * taken as the main number.
 */
const CONTAINS: [ImportField, RegExp][] = [
  ["email", /\be ?mail\b/],
  ["mobilePhone", /\b(mobile|cell)\b/],
  ["phone", /\bphone\b/],
  ["postalCode", /\b(zip|postal|postcode)\b/],
  ["city", /\bcity\b/],
  ["state", /\b(state|province)\b/],
  ["line2", /\b(address|street) ?(line )?2\b/],
  ["line1", /\b(street|address)\b/],
  ["businessName", /\b(company|business)\b/],
  ["firstName", /\bfirst\b/],
  ["lastName", /\blast\b/],
  ["notes", /\bnotes?\b/],
];

/**
 * A first guess at what each column holds, from its heading. Each field is
 * taken by one column at most — the first that claims it.
 */
export function guessMapping(headings: string[]): ColumnMapping {
  const mapping: ColumnMapping = headings.map(() => null);
  const taken = new Set<ImportField>();
  const normalized = headings.map(normalizeHeading);

  normalized.forEach((heading, column) => {
    for (const field of IMPORT_FIELDS) {
      if (!taken.has(field.key) && EXACT[field.key].includes(heading)) {
        mapping[column] = field.key;
        taken.add(field.key);
        return;
      }
    }
  });

  normalized.forEach((heading, column) => {
    if (mapping[column] || !heading) return;
    for (const [field, pattern] of CONTAINS) {
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
 * One customer as it will be saved. The address and the note are optional
 * because the file may have neither.
 */
export type ClientDraft = {
  type: ClientType;
  firstName: string | null;
  lastName: string | null;
  businessName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  website: string | null;
  source: LeadSource | null;
  taxExempt: boolean;
  address: {
    line1: string;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  } | null;
  note: string | null;
};

/** What happens to one line of the file. */
export type ImportRow = {
  /** The line number a spreadsheet would show — the headings are line 1. */
  line: number;
  draft: ClientDraft | null;
  /** Why the line is not imported, when it is not. */
  skipped: "no-name" | "on-file" | "repeated" | null;
  /** Things left off a line that is still imported. */
  warnings: string[];
};

export type ImportPlan = {
  rows: ImportRow[];
  ready: ImportRow[];
  /** Lines naming a customer already on file. */
  onFile: ImportRow[];
  /** Lines naming the same customer as an earlier line of the same file. */
  repeated: ImportRow[];
  /** Lines with no name to save under. */
  unnamed: ImportRow[];
  warned: ImportRow[];
};

/** Endings that mark a name as a company's: "Smith Plumbing LLC". */
const BUSINESS_SUFFIX =
  /\b(llc|l\.l\.c\.?|inc\.?|incorporated|corp\.?|corporation|company|ltd\.?|llp|pllc)$/i;

const emailSchema = z.string().email();

function lowerSquash(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Digits of a phone number, without a leading US country code. */
function phoneDigits(value: string | null) {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return local.length >= 7 ? local : null;
}

/**
 * The ways a customer is recognised as already being here: the same email, or
 * the same name and the same phone number. A record with neither email nor
 * phone can only be recognised by name, and only matches another with
 * neither — so importing the same file twice adds nobody, while two different
 * "John Smith"s with different numbers both arrive.
 */
export function matchKeys(client: {
  displayName: string;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
}): string[] {
  const keys: string[] = [];
  const name = lowerSquash(client.displayName);
  const email = client.email?.trim().toLowerCase();
  const phones = [phoneDigits(client.phone), phoneDigits(client.mobilePhone)].filter(
    (digits): digits is string => Boolean(digits),
  );

  if (email) keys.push(`e:${email}`);
  for (const digits of phones) keys.push(`p:${name}|${digits}`);
  if (!email && phones.length === 0 && name) keys.push(`n:${name}`);
  return keys;
}

/** A spreadsheet's answer for the source, as one of the app's own sources. */
function readSource(value: string): LeadSource {
  const text = lowerSquash(value.replace(/[_-]/g, " "));
  const direct = LEAD_SOURCES.find((source) => lowerSquash(source.replace(/_/g, " ")) === text);
  if (direct) return direct;

  if (/(google|search|seo|bing|yelp|angi|thumbtack|houzz)/.test(text)) return "GOOGLE";
  if (/(facebook|instagram|nextdoor|tiktok|social|twitter|linkedin)/.test(text)) return "SOCIAL";
  if (/(refer|word of mouth|friend|neighbo)/.test(text)) return "REFERRAL";
  if (/(website|web|online|internet)/.test(text)) return "WEBSITE";
  if (/(repeat|returning|existing)/.test(text)) return "REPEAT";
  if (/(walk ?in|drive ?by|\bsign\b|truck)/.test(text)) return "WALK_IN";
  return "OTHER";
}

function readYes(value: string) {
  return /^(y|yes|true|1|x|exempt|tax exempt)$/i.test(value.trim());
}

/** "Smith, Jane" or "Jane Q. Smith" → first and last. */
function splitName(full: string): { firstName: string | null; lastName: string | null } {
  const comma = full.indexOf(",");
  if (comma > 0) {
    const last = full.slice(0, comma).trim();
    const first = full.slice(comma + 1).trim();
    return { firstName: first || null, lastName: last || null };
  }

  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

/** Builds one customer from one line, or says why it cannot. */
function readLine(
  cells: string[],
  mapping: ColumnMapping,
): { draft: ClientDraft | null; warnings: string[] } {
  const value = (field: ImportField): string | null => {
    const column = mapping.indexOf(field);
    if (column < 0) return null;
    const cell = (cells[column] ?? "").trim();
    return cell === "" ? null : cell;
  };

  const warnings: string[] = [];

  let businessName = value("businessName");
  let firstName = value("firstName");
  let lastName = value("lastName");
  const fullName = value("fullName");

  // QuickBooks fills "Customer" with the company's own name when there is one;
  // that is not a person to file the company under.
  const fullIsCompany =
    fullName && businessName && lowerSquash(fullName) === lowerSquash(businessName);

  if (fullName && !firstName && !lastName && !fullIsCompany) {
    if (!businessName && BUSINESS_SUFFIX.test(fullName)) {
      businessName = fullName;
    } else {
      ({ firstName, lastName } = splitName(fullName));
    }
  }

  const type: ClientType = businessName ? "BUSINESS" : "PERSON";
  const displayName =
    type === "BUSINESS"
      ? businessName!
      : [firstName, lastName].filter(Boolean).join(" ");

  if (!displayName) return { draft: null, warnings };

  // A cell may hold several addresses; the first good one is kept.
  let email: string | null = null;
  const emailCell = value("email");
  if (emailCell) {
    const candidates = emailCell.split(/[;,\s]+/).filter(Boolean);
    email = candidates.find((candidate) => emailSchema.safeParse(candidate).success) ?? null;
    if (!email) {
      warnings.push(`“${emailCell}” is not an email address, so it was left off.`);
    } else if (candidates.length > 1) {
      warnings.push(`Only the first email, ${email}, was kept.`);
    }
  }

  const line1 = value("line1");
  const city = value("city");
  const state = value("state");
  const postalCode = value("postalCode");
  const line2 = value("line2");

  if (!line1 && (city || state || postalCode)) {
    warnings.push("No street address, so the address was left off.");
  }

  const sourceCell = value("source");
  const taxCell = value("taxExempt");

  return {
    draft: {
      type,
      firstName,
      lastName,
      businessName,
      displayName,
      email,
      phone: value("phone"),
      mobilePhone: value("mobilePhone"),
      website: value("website"),
      source: sourceCell ? readSource(sourceCell) : null,
      taxExempt: taxCell ? readYes(taxCell) : false,
      address: line1 ? { line1, line2, city, state, postalCode } : null,
      note: value("notes"),
    },
    warnings,
  };
}

/** True when the mapping says where a name comes from. */
export function mapsAName(mapping: ColumnMapping) {
  return mapping.some(
    (field) =>
      field === "fullName" ||
      field === "firstName" ||
      field === "lastName" ||
      field === "businessName",
  );
}

/**
 * Every line of the file, decided: imported, already on file, repeated, or
 * missing a name. `table` includes the headings as its first row.
 */
export function planImport(
  table: string[][],
  mapping: ColumnMapping,
  onFileKeys: Iterable<string>,
): ImportPlan {
  const seen = new Set(onFileKeys);
  const inFile = new Set<string>();
  const rows: ImportRow[] = [];

  table.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const { draft, warnings } = readLine(cells, mapping);

    if (!draft) {
      rows.push({ line, draft: null, skipped: "no-name", warnings: [] });
      return;
    }

    const keys = matchKeys(draft);
    if (keys.some((key) => seen.has(key))) {
      rows.push({ line, draft, skipped: "on-file", warnings: [] });
      return;
    }
    if (keys.some((key) => inFile.has(key))) {
      rows.push({ line, draft, skipped: "repeated", warnings: [] });
      return;
    }

    for (const key of keys) inFile.add(key);
    rows.push({ line, draft, skipped: null, warnings });
  });

  return {
    rows,
    ready: rows.filter((row) => !row.skipped),
    onFile: rows.filter((row) => row.skipped === "on-file"),
    repeated: rows.filter((row) => row.skipped === "repeated"),
    unnamed: rows.filter((row) => row.skipped === "no-name"),
    warned: rows.filter((row) => !row.skipped && row.warnings.length > 0),
  };
}

/** The headings and two example lines of the downloadable template. */
export const IMPORT_TEMPLATE: string[][] = [
  [
    "First name", "Last name", "Company", "Email", "Phone", "Mobile phone",
    "Street address", "Address line 2", "City", "State", "ZIP", "Notes",
  ],
  [
    "Jane", "Doe", "", "jane.doe@example.com", "(865) 555-0142", "",
    "12 Oak Street", "", "Knoxville", "TN", "37902", "Gate code 4411",
  ],
  [
    "Sam", "Lee", "Riverside Dental", "office@example.com", "(865) 555-0199",
    "(865) 555-0123", "400 Main Street", "Suite 2", "Lenoir City", "TN",
    "37771", "Send invoices to the office manager",
  ],
];

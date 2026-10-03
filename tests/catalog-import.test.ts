import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Importing a price list into the price book.
 *
 * The rules are pinned against what price lists actually hold — QuickBooks'
 * own export, "$85/yd", "call for quote" — and the action against the test
 * database: items land in this business only, the kind chosen on the page
 * fills the gaps, and the same file sent twice adds nothing.
 */

const session = vi.hoisted(() => ({
  user: null as unknown as Record<string, unknown>,
  org: null as unknown as Record<string, unknown>,
}));

vi.mock("@/lib/auth", () => ({
  requireContext: async () => session,
  requirePermission: async () => session,
  getContext: async () => session,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { importCatalogItems } from "@/app/(app)/catalog/import/actions";
import { priceBook } from "@/app/(app)/estimates/queries";
import {
  CATALOG_IMPORT_TEMPLATE,
  guessCatalogMapping,
  planCatalogImport,
} from "@/lib/catalog-import";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/db";
import { readYesNo, sanitizeMapping } from "@/lib/import-columns";

// ---------------------------------------------------------------- columns ---

describe("guessing the columns", () => {
  it("reads a QuickBooks Online products and services export", () => {
    expect(
      guessCatalogMapping([
        "Product/Service Name", "Sales Description", "SKU", "Type",
        "Sales Price / Rate", "Taxable", "Income Account", "Purchase Description",
        "Purchase Cost", "Expense Account", "Quantity On Hand",
      ]),
    ).toEqual([
      "name", "description", null, "kind", "price", "taxable", null, null,
      null, null, null,
    ]);
  });

  it("reads looser headings, price before unit", () => {
    expect(guessCatalogMapping(["Item", "Unit Price (USD)", "UOM", "Category"])).toEqual([
      "name", "price", "unit", null,
    ]);
  });

  it("recognises every heading of its own template", () => {
    expect(guessCatalogMapping(CATALOG_IMPORT_TEMPLATE[0]).every(Boolean)).toBe(true);
  });
});

describe("shared column helpers", () => {
  it("keeps only known fields, each from one column", () => {
    const isField = (v: unknown): v is "a" | "b" => v === "a" || v === "b";
    expect(sanitizeMapping(["a", "a", "zzz", "b"], 5, isField)).toEqual(["a", null, null, "b", null]);
    expect(sanitizeMapping("not a list", 2, isField)).toEqual([null, null]);
  });

  it("reads yes and no the way people write them", () => {
    expect(["Yes", "y", "TRUE", "1", "x"].map(readYesNo)).toEqual([true, true, true, true, true]);
    expect(["No", "n", "false", "0", "-"].map(readYesNo)).toEqual([false, false, false, false, false]);
    expect(readYesNo("maybe")).toBeNull();
  });
});

// ------------------------------------------------------------------ rules ---

function plan(rows: string[][], onFile: string[] = [], kind: "SERVICE" | "MATERIAL" = "SERVICE") {
  return planCatalogImport(rows, guessCatalogMapping(rows[0]), onFile, kind);
}

describe("deciding each line", () => {
  it("reads the kinds QuickBooks and people use, and says when it cannot", () => {
    const result = plan([
      ["Name", "Type"],
      ["A", "Service"],
      ["B", "Non-inventory"],
      ["C", "Inventory"],
      ["D", "Labour"],
      ["E", "Bundle"],
      ["F", "Widget"],
      ["G", ""],
    ], [], "MATERIAL");

    expect(result.ready.map((row) => row.draft?.kind)).toEqual([
      "SERVICE", "MATERIAL", "MATERIAL", "LABOR", "OTHER", "MATERIAL", "MATERIAL",
    ]);
    expect(result.defaulted).toBe(2);
    expect(result.warned.map((row) => row.warnings)).toEqual([
      ["“Widget” is not a kind Matlock One knows, so it was filed as Material."],
    ]);
  });

  it("reads prices as people type them, with a unit tucked into the price", () => {
    const { ready } = plan([
      ["Name", "Price", "Unit"],
      ["Install", "$1,250.00", ""],
      ["Mulch", "$85/yd", ""],
      ["Sod", "1.10 per sq ft", ""],
      ["Gravel", "$40/ton", "load"],
      ["Consult", "", ""],
    ]);
    expect(ready.map((row) => [row.draft?.unitPriceCents, row.draft?.unit])).toEqual([
      [125_000, "ea"],
      [8_500, "yd"],
      [110, "sq ft"],
      [4_000, "load"],
      [0, "ea"],
    ]);
    expect(ready.every((row) => row.warnings.length === 0)).toBe(true);
  });

  it("brings in a price it cannot read at 0, and says so", () => {
    const { ready } = plan([["Name", "Price"], ["Tree removal", "Call for quote"], ["Credit", "-5"]]);
    expect(ready.map((row) => row.draft?.unitPriceCents)).toEqual([0, 0]);
    expect(ready.map((row) => row.warnings)).toEqual([
      ["“Call for quote” is not a price, so it was set to 0."],
      ["“-5” is not a price, so it was set to 0."],
    ]);
  });

  it("keeps a unit short enough for the price book", () => {
    const { ready } = plan([["Name", "Unit"], ["Fence", "linear foot of fencing"]]);
    expect(ready[0].draft?.unit).toBe("ea");
    expect(ready[0].warnings).toEqual([
      "The unit “linear foot of fencing” is too long for a unit, so it was set to ea.",
    ]);
  });

  it("reads taxable as yes, no, or QuickBooks' own words", () => {
    const { ready } = plan([
      ["Name", "Taxable"],
      ["A", "No"],
      ["B", "Yes"],
      ["C", "Non-taxable"],
      ["D", "Taxable"],
      ["E", ""],
      ["F", "maybe"],
    ]);
    expect(ready.map((row) => row.draft?.taxable)).toEqual([false, true, false, true, true, true]);
    expect(ready[5].warnings).toEqual(["“maybe” is not yes or no, so it was marked taxable."]);
  });

  it("skips what the price book already has, and what the file repeats", () => {
    const result = plan(
      [["Name"], ["Lawn  Mowing"], ["Edging"], ["edging"], [""], ["Aeration"]],
      ["lawn mowing"],
    );
    expect(result.onFile.map((row) => row.line)).toEqual([2]);
    expect(result.repeated.map((row) => row.line)).toEqual([4]);
    expect(result.unnamed.map((row) => row.line)).toEqual([5]);
    expect(result.ready.map((row) => row.draft?.name)).toEqual(["Edging", "Aeration"]);
  });
});

// ----------------------------------------------------------------- saving ---

const orgs: string[] = [];
let organizationId: string;

async function makeBusiness(name: string) {
  const org = await prisma.organization.create({
    data: { slug: `catalog-import-${randomUUID()}`, name },
  });
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `${randomUUID()}@test.local`,
      name: "Owner",
      passwordHash: "not-used",
      role: "OWNER",
    },
  });
  orgs.push(org.id);
  return { org, user };
}

async function signIn(name: string) {
  const { org, user } = await makeBusiness(name);
  session.org = org as unknown as Record<string, unknown>;
  session.user = user as unknown as Record<string, unknown>;
  return org.id;
}

beforeEach(async () => {
  organizationId = await signIn("Catalog Import Co");
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

const FILE = toCsv([
  ["Item", "Description", "Price", "Taxable"],
  ["Service call", "Trip charge", "125", "No"],
  ["Hardwood mulch", "Delivered and spread", "$85/yd", "Yes"],
  ["", "orphan", "10", ""],
]);

describe("importing", () => {
  it("adds each item to this business's price book, ready for documents", async () => {
    const mapping = guessCatalogMapping(["Item", "Description", "Price", "Taxable"]);
    expect(await importCatalogItems(FILE, mapping, "MATERIAL")).toEqual({
      ok: true, created: 2, onFile: 0, repeated: 0, unnamed: 1,
    });

    const items = await prisma.priceBookItem.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: { name: true, kind: true, description: true, unit: true, unitPriceCents: true, taxable: true, isActive: true },
    });
    expect(items).toEqual([
      { name: "Hardwood mulch", kind: "MATERIAL", description: "Delivered and spread", unit: "yd", unitPriceCents: 8_500, taxable: true, isActive: true },
      { name: "Service call", kind: "MATERIAL", description: "Trip charge", unit: "ea", unitPriceCents: 12_500, taxable: false, isActive: true },
    ]);

    // The point of a price book: the document editors offer what came in.
    expect((await priceBook(organizationId)).map((item) => item.name).sort()).toEqual([
      "Hardwood mulch",
      "Service call",
    ]);
  });

  it("adds nothing when the same file is imported again, even once archived", async () => {
    const mapping = guessCatalogMapping(["Item", "Description", "Price", "Taxable"]);
    await importCatalogItems(FILE, mapping, "SERVICE");
    await prisma.priceBookItem.updateMany({ where: { organizationId }, data: { isActive: false } });

    expect(await importCatalogItems(FILE, mapping, "SERVICE")).toEqual({
      ok: true, created: 0, onFile: 2, repeated: 0, unnamed: 1,
    });
    expect(await prisma.priceBookItem.count({ where: { organizationId } })).toBe(2);
  });

  it("checks against this business's price book, not another's", async () => {
    const mapping = guessCatalogMapping(["Item", "Description", "Price", "Taxable"]);
    await importCatalogItems(FILE, mapping, "SERVICE");

    const other = await signIn("Another Co");
    expect(await importCatalogItems(FILE, mapping, "SERVICE")).toMatchObject({ ok: true, created: 2 });
    expect(await prisma.priceBookItem.count({ where: { organizationId: other } })).toBe(2);
  });

  it("files items under Service when the page sends a kind it does not know", async () => {
    await importCatalogItems(FILE, guessCatalogMapping(["Item", "Description", "Price", "Taxable"]), "DROP");
    const kinds = await prisma.priceBookItem.findMany({ where: { organizationId }, select: { kind: true } });
    expect(kinds.map((row) => row.kind)).toEqual(["SERVICE", "SERVICE"]);
  });

  it("refuses a file whose name column was not chosen, and saves nothing", async () => {
    expect(await importCatalogItems(FILE, [null, "description", "price", "taxable"], "SERVICE")).toEqual({
      ok: false,
      error: "Choose the column that holds each item's name before importing.",
    });
    expect(await prisma.priceBookItem.count({ where: { organizationId } })).toBe(0);
  });
});

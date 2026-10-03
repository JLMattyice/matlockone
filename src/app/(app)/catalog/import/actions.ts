"use server";

import { revalidatePath } from "next/cache";

import { catalogNames } from "./queries";
import { requirePermission } from "@/lib/auth";
import {
  isCatalogImportField,
  isLineItemKindValue,
  planCatalogImport,
} from "@/lib/catalog-import";
import { parseCsv } from "@/lib/csv";
import { prisma } from "@/lib/db";
import {
  IMPORT_MAX_BYTES,
  inGroups,
  sanitizeMapping,
  tableProblem,
} from "@/lib/import-columns";

export type CatalogImportResult =
  | { ok: true; created: number; onFile: number; repeated: number; unnamed: number }
  | { ok: false; error: string };

/**
 * Imports a price list into the price book.
 *
 * As with customers, the file is parsed and decided again here, against the
 * price book as it is now, and written in one transaction — so the same file
 * sent twice adds nothing the second time, and a failure adds nothing at all.
 */
export async function importCatalogItems(
  csv: string,
  rawMapping: unknown,
  rawDefaultKind: unknown,
): Promise<CatalogImportResult> {
  const { org } = await requirePermission("catalog:write");

  if (typeof csv !== "string" || csv.trim() === "") {
    return { ok: false, error: "That file is empty." };
  }
  if (csv.length > IMPORT_MAX_BYTES) {
    return { ok: false, error: "That file is over 4 MB. Split the list into parts and import each one." };
  }

  const table = parseCsv(csv);
  const problem = tableProblem(table);
  if (problem) return { ok: false, error: problem };

  const mapping = sanitizeMapping(rawMapping, table[0].length, isCatalogImportField);
  if (!mapping.includes("name")) {
    return { ok: false, error: "Choose the column that holds each item's name before importing." };
  }

  const defaultKind = isLineItemKindValue(rawDefaultKind) ? rawDefaultKind : "SERVICE";
  const plan = planCatalogImport(table, mapping, await catalogNames(org.id), defaultKind);

  const items = plan.ready.flatMap(({ draft }) =>
    draft
      ? [
          {
            organizationId: org.id,
            kind: draft.kind,
            name: draft.name,
            description: draft.description,
            unit: draft.unit,
            unitPriceCents: draft.unitPriceCents,
            taxable: draft.taxable,
          },
        ]
      : [],
  );

  if (items.length > 0) {
    await prisma.$transaction(
      inGroups(items).map((data) => prisma.priceBookItem.createMany({ data })),
    );
    // Both document editors offer the price book, so an estimate already
    // open in another tab should see the new items.
    revalidatePath("/catalog");
    revalidatePath("/estimates");
    revalidatePath("/invoices");
  }

  return {
    ok: true,
    created: items.length,
    onFile: plan.onFile.length,
    repeated: plan.repeated.length,
    unnamed: plan.unnamed.length,
  };
}

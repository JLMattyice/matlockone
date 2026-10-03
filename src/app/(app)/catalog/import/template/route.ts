import { NextResponse } from "next/server";

import { getContext } from "@/lib/auth";
import { CATALOG_IMPORT_TEMPLATE } from "@/lib/catalog-import";
import { toCsv } from "@/lib/csv";
import { can } from "@/lib/permissions";

/** A price list to fill in, with headings the importer recognises on its own. */
export async function GET() {
  const ctx = await getContext();
  if (!ctx || !can(ctx.user, "catalog:write")) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(toCsv(CATALOG_IMPORT_TEMPLATE), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="price-book-template.csv"',
      "Cache-Control": "no-store",
    },
  });
}

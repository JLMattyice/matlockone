import { NextResponse } from "next/server";

import { getContext } from "@/lib/auth";
import { IMPORT_TEMPLATE } from "@/lib/client-import";
import { toCsv } from "@/lib/csv";
import { can } from "@/lib/permissions";

/**
 * A blank list to fill in, for a business whose customers live on paper or in
 * somebody's head. The headings are ones the importer recognises on its own.
 */
export async function GET() {
  const ctx = await getContext();
  if (!ctx || !can(ctx.user, "clients:write")) {
    return new NextResponse("Not found", { status: 404 });
  }

  const name = `${ctx.org.labelClientPlural.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-template.csv`;

  return new NextResponse(toCsv(IMPORT_TEMPLATE), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

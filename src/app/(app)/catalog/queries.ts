import { prisma } from "@/lib/db";
import { LINE_ITEM_KINDS, type LineItemKind } from "@/lib/constants";

/**
 * Reads for the catalog: what the business sells, and what its own estimates
 * and invoices offer as one-click line items.
 *
 * The same rows are read from the document editors through `priceBook()` in
 * the estimates queries, which filters to active entries only. Here both
 * active and archived are reachable, because archiving is something the owner
 * has to be able to see and undo.
 */

const PAGE_SIZE = 25;

export const CATALOG_VIEWS = ["active", "archived", "all"] as const;
export type CatalogView = (typeof CATALOG_VIEWS)[number];

export function asCatalogView(value: string | undefined): CatalogView {
  return CATALOG_VIEWS.includes(value as CatalogView)
    ? (value as CatalogView)
    : "active";
}

function isActiveFilter(view: CatalogView) {
  if (view === "all") return {};
  return { isActive: view === "active" };
}

type CatalogQuery = {
  organizationId: string;
  q?: string;
  kind?: string;
  view: CatalogView;
};

function where({ organizationId, q, kind, view }: CatalogQuery) {
  const search = q?.trim();

  return {
    organizationId,
    ...isActiveFilter(view),
    ...(LINE_ITEM_KINDS.includes(kind as LineItemKind)
      ? { kind: kind as LineItemKind }
      : {}),
    // SQLite has no case-insensitive mode flag in Prisma, and the desktop build
    // runs on SQLite, so this stays a plain contains — the same compromise the
    // other list screens make.
    ...(search
      ? {
          OR: [
            { name: { contains: search } },
            { description: { contains: search } },
          ],
        }
      : {}),
  };
}

export async function listCatalogItems(
  query: CatalogQuery & { page?: number },
) {
  const page = Math.max(1, query.page ?? 1);
  const filter = where(query);

  const [rows, total] = await Promise.all([
    prisma.priceBookItem.findMany({
      where: filter,
      // Name within kind: a price book is read by looking for a thing, and the
      // kinds keep services and materials from interleaving.
      orderBy: [{ kind: "asc" }, { name: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.priceBookItem.count({ where: filter }),
  ]);

  return {
    rows,
    total,
    page,
    pageSize: PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

/**
 * The counts above the list. `archived` is counted whatever the current view
 * is, so the tab showing it can carry a number even while active items are on
 * screen.
 */
export async function catalogSummary(organizationId: string) {
  const [active, archived, byKind] = await Promise.all([
    prisma.priceBookItem.count({ where: { organizationId, isActive: true } }),
    prisma.priceBookItem.count({ where: { organizationId, isActive: false } }),
    prisma.priceBookItem.groupBy({
      by: ["kind"],
      where: { organizationId, isActive: true },
      _count: { _all: true },
    }),
  ]);

  return {
    active,
    archived,
    byKind: new Map(byKind.map((row) => [row.kind, row._count._all])),
  };
}

export async function getCatalogItem(organizationId: string, id: string) {
  return prisma.priceBookItem.findFirst({ where: { id, organizationId } });
}

/**
 * Units already in use, offered as suggestions on the form.
 *
 * Read from the organization's own rows rather than a fixed list: "ea" and
 * "hr" are close to universal, but a business measuring in cubic yards or
 * linear feet should be typing that once, not every time.
 */
export async function unitsInUse(organizationId: string): Promise<string[]> {
  const rows = await prisma.priceBookItem.findMany({
    where: { organizationId },
    select: { unit: true },
    distinct: ["unit"],
    orderBy: { unit: "asc" },
    take: 25,
  });

  const used = rows.map((row) => row.unit).filter(Boolean);
  const common = ["ea", "hr", "day", "ft", "sq ft", "job"];

  return [...new Set([...used, ...common])];
}

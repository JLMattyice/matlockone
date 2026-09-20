import type { Metadata } from "next";
import Link from "next/link";
import { Archive, Pencil, Plus, Tag, Undo2 } from "lucide-react";

import { setCatalogItemActive } from "./actions";
import { asCatalogView, catalogSummary, listCatalogItems } from "./queries";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  LINE_ITEM_KIND_LABELS,
  LINE_ITEM_KINDS,
  type LineItemKind,
} from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Products & services" };

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    kind?: string;
    view?: string;
    page?: string;
  }>;
}) {
  const { user, org } = await requirePermission("catalog:read");
  const params = await searchParams;
  const view = asCatalogView(params.view);

  const [list, summary] = await Promise.all([
    listCatalogItems({
      organizationId: org.id,
      q: params.q,
      kind: params.kind,
      view,
      page: Number(params.page) || 1,
    }),
    catalogSummary(org.id),
  ]);

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const writable = can(user, "catalog:write");
  const isFiltered = Boolean(params.q || params.kind);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products & services"
        description={
          summary.active === 0
            ? "What this business sells, ready to drop onto an estimate."
            : `${summary.active} offered on documents${
                summary.archived ? ` · ${summary.archived} archived` : ""
              }`
        }
        actions={
          writable ? (
            <Link href="/catalog/new" className={buttonClasses("primary", "md")}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              New item
            </Link>
          ) : null
        }
      />

      <ListToolbar
        searchPlaceholder="Search by name or description…"
        filters={[
          {
            name: "kind",
            label: "kinds",
            options: LINE_ITEM_KINDS.map((kind) => ({
              value: kind,
              label: `${LINE_ITEM_KIND_LABELS[kind]} (${summary.byKind.get(kind) ?? 0})`,
            })),
          },
          {
            name: "view",
            label: "items",
            options: [
              { value: "active", label: `Offered (${summary.active})` },
              { value: "archived", label: `Archived (${summary.archived})` },
              { value: "all", label: "All" },
            ],
          },
        ]}
      />

      <Card className="overflow-hidden">
        {list.rows.length === 0 ? (
          <EmptyState
            icon={<Tag className="h-5 w-5" strokeWidth={1.75} />}
            title={
              isFiltered
                ? "No matches"
                : view === "archived"
                  ? "Nothing archived"
                  : "Nothing in the catalog yet"
            }
            description={
              isFiltered
                ? "Try a different search or clear the filters."
                : view === "archived"
                  ? "Archiving takes an item out of the estimate and invoice pickers while leaving every document already priced with it alone."
                  : "Add what you sell once, and every estimate and invoice can pick it in a click instead of retyping the wording and the price."
            }
            action={
              !isFiltered && writable && view !== "archived" ? (
                <Link
                  href="/catalog/new"
                  className={buttonClasses("primary", "md")}
                >
                  <Plus className="h-4 w-4" strokeWidth={2} />
                  New item
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <Th>Name</Th>
                <Th className="hidden sm:table-cell">Kind</Th>
                <Th className="hidden md:table-cell">Unit</Th>
                <Th align="right">Price</Th>
                <Th className="w-px" />
              </THead>
              <TBody>
                {list.rows.map((item) => {
                  const kind = asStatus(
                    LINE_ITEM_KINDS,
                    item.kind,
                    "OTHER",
                  ) as LineItemKind;

                  return (
                    <Tr key={item.id}>
                      <Td>
                        <div className="flex items-start gap-2">
                          <div className="min-w-0">
                            <Link
                              href={
                                writable ? `/catalog/${item.id}/edit` : "/catalog"
                              }
                              className="text-sm font-medium text-ink transition-colors hover:text-brand"
                            >
                              {item.name}
                            </Link>
                            {item.description ? (
                              <p className="mt-0.5 line-clamp-1 text-xs text-ink-muted">
                                {item.description}
                              </p>
                            ) : null}
                            <p className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">
                              <Badge tone="neutral">
                                {LINE_ITEM_KIND_LABELS[kind]}
                              </Badge>
                            </p>
                          </div>
                          {item.isActive ? null : (
                            <Badge tone="warning">Archived</Badge>
                          )}
                        </div>
                      </Td>

                      <Td className="hidden sm:table-cell">
                        <Badge tone="neutral">{LINE_ITEM_KIND_LABELS[kind]}</Badge>
                      </Td>

                      <Td className="hidden md:table-cell text-ink-muted">
                        {item.unit}
                      </Td>

                      <Td align="right">
                        <span className="tabular text-sm font-medium text-ink">
                          {money(item.unitPriceCents)}
                        </span>
                        {item.taxable ? null : (
                          <span className="mt-0.5 block text-xs text-ink-subtle">
                            No tax
                          </span>
                        )}
                      </Td>

                      <Td>
                        {writable ? (
                          <div className="flex items-center justify-end gap-1">
                            <Link
                              href={`/catalog/${item.id}/edit`}
                              className={buttonClasses("ghost", "sm")}
                              aria-label={`Edit ${item.name}`}
                            >
                              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </Link>

                            {/* A form, not a link: it changes something, and it
                                keeps working before hydration. */}
                            <form action={setCatalogItemActive}>
                              <input type="hidden" name="id" value={item.id} />
                              <input
                                type="hidden"
                                name="isActive"
                                value={item.isActive ? "false" : "true"}
                              />
                              <button
                                type="submit"
                                className={buttonClasses("ghost", "sm")}
                                aria-label={
                                  item.isActive
                                    ? `Archive ${item.name}`
                                    : `Restore ${item.name}`
                                }
                                title={item.isActive ? "Archive" : "Restore"}
                              >
                                {item.isActive ? (
                                  <Archive
                                    className="h-3.5 w-3.5"
                                    strokeWidth={1.75}
                                  />
                                ) : (
                                  <Undo2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                                )}
                              </button>
                            </form>
                          </div>
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>

            <Pagination
              page={list.page}
              pageCount={list.pageCount}
              total={list.total}
              pageSize={list.pageSize}
              pathname="/catalog"
              params={params}
              itemLabel="items"
            />
          </>
        )}
      </Card>
    </div>
  );
}

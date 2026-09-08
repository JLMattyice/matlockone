import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { Plus, Users } from "lucide-react";

import { clientStatusCounts, listClients, type ClientSort } from "./queries";
import { Avatar } from "@/components/ui/avatar";
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
  CLIENT_STATUS_META,
  CLIENT_STATUSES,
} from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/utils";

export const metadata: Metadata = { title: "Clients" };

type SearchParams = Promise<{
  q?: string;
  status?: string;
  type?: string;
  sort?: string;
  page?: string;
}>;

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { user, org } = await requirePermission("clients:read");
  const params = await searchParams;

  const sort = (["name", "newest", "activity"] as const).includes(
    params.sort as ClientSort,
  )
    ? (params.sort as ClientSort)
    : "name";

  const [list, counts] = await Promise.all([
    listClients({
      organizationId: org.id,
      q: params.q,
      status: params.status,
      type: params.type,
      sort,
      page: Number(params.page) || 1,
    }),
    clientStatusCounts(org.id),
  ]);

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const writable = can(user, "clients:write");
  const isFiltered = Boolean(params.q || params.status || params.type);

  return (
    <div className="space-y-6">
      <PageHeader
        title={org.labelClientPlural}
        description={`${counts.get("ACTIVE") ?? 0} active · ${list.total} shown`}
        actions={
          writable ? (
            <Link href="/clients/new" className={buttonClasses("primary", "md")}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              New {org.labelClientSingular.toLowerCase()}
            </Link>
          ) : null
        }
      />

      <ListToolbar
        searchPlaceholder="Search name, email, phone or address…"
        filters={[
          {
            name: "status",
            label: "statuses",
            options: CLIENT_STATUSES.map((status) => ({
              value: status,
              label: `${CLIENT_STATUS_META[status].label} (${counts.get(status) ?? 0})`,
            })),
          },
          {
            name: "type",
            label: "types",
            options: [
              { value: "PERSON", label: "People" },
              { value: "BUSINESS", label: "Businesses" },
            ],
          },
          {
            name: "sort",
            label: "sort",
            allLabel: "Sort: Name",
            options: [
              { value: "newest", label: "Sort: Newest" },
              { value: "activity", label: "Sort: Recent activity" },
            ],
          },
        ]}
      />

      <Card className="overflow-hidden">
        {list.rows.length === 0 ? (
          <EmptyState
            icon={<Users className="h-5 w-5" strokeWidth={1.75} />}
            title={
              isFiltered
                ? "No matches"
                : `No ${org.labelClientPlural.toLowerCase()} yet`
            }
            description={
              isFiltered
                ? "Try a different search or clear the filters."
                : "Add your first customer to start scheduling work and sending invoices."
            }
            action={
              !isFiltered && writable ? (
                <Link href="/clients/new" className={buttonClasses("primary", "md")}>
                  <Plus className="h-4 w-4" strokeWidth={2} />
                  New {org.labelClientSingular.toLowerCase()}
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <Th>Name</Th>
                <Th>Contact</Th>
                <Th className="hidden lg:table-cell">Location</Th>
                <Th align="right" className="hidden sm:table-cell">
                  Jobs
                </Th>
                <Th align="right">Outstanding</Th>
                <Th className="hidden xl:table-cell">Last job</Th>
                <Th>Status</Th>
              </THead>

              <TBody>
                {list.rows.map((client) => {
                  const status = asStatus(
                    CLIENT_STATUSES,
                    client.status,
                    "ACTIVE",
                  );
                  const meta = CLIENT_STATUS_META[status];
                  const address = client.addresses[0];

                  return (
                    <Tr key={client.id}>
                      <Td>
                        <Link
                          href={`/clients/${client.id}`}
                          className="flex items-center gap-3 group"
                        >
                          <Avatar
                            name={client.displayName}
                            isBusiness={client.type === "BUSINESS"}
                            size="sm"
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-ink group-hover:text-brand">
                              {client.displayName}
                            </span>
                            {client.type === "BUSINESS" &&
                            (client.firstName || client.lastName) ? (
                              <span className="block truncate text-xs text-ink-subtle">
                                {[client.firstName, client.lastName]
                                  .filter(Boolean)
                                  .join(" ")}
                              </span>
                            ) : null}
                          </span>
                        </Link>
                      </Td>

                      <Td>
                        <span className="block truncate text-ink-muted">
                          {client.email ?? "—"}
                        </span>
                        <span className="tabular block text-xs text-ink-subtle">
                          {formatPhone(client.phone) || ""}
                        </span>
                      </Td>

                      <Td className="hidden lg:table-cell">
                        {address ? (
                          <span className="block truncate text-ink-muted">
                            {[address.city, address.state]
                              .filter(Boolean)
                              .join(", ") || address.line1}
                          </span>
                        ) : (
                          <span className="text-ink-subtle">—</span>
                        )}
                      </Td>

                      <Td align="right" className="tabular hidden sm:table-cell">
                        {client._count.jobs || "—"}
                      </Td>

                      <Td align="right" className="tabular">
                        {client.outstandingCents > 0 ? (
                          <span className="font-medium text-warning">
                            {money(client.outstandingCents)}
                          </span>
                        ) : (
                          <span className="text-ink-subtle">—</span>
                        )}
                      </Td>

                      <Td className="tabular hidden text-ink-muted xl:table-cell">
                        {client.lastJobAt
                          ? format(client.lastJobAt, "MMM d, yyyy")
                          : "—"}
                      </Td>

                      <Td>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
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
              pathname="/clients"
              params={{
                q: params.q,
                status: params.status,
                type: params.type,
                sort: params.sort,
              }}
              itemLabel={org.labelClientPlural.toLowerCase()}
            />
          </>
        )}
      </Card>
    </div>
  );
}

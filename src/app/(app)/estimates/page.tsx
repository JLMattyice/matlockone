import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { FileText, Plus } from "lucide-react";

import { estimateSummary, listEstimates } from "./queries";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import { ESTIMATE_STATUS_META, ESTIMATE_STATUSES } from "@/lib/constants";
import { effectiveEstimateStatus } from "@/lib/documents";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Estimates" };

export default async function EstimatesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    clientId?: string;
    page?: string;
  }>;
}) {
  const { user, org } = await requirePermission("estimates:read");
  const params = await searchParams;

  const [list, summary] = await Promise.all([
    listEstimates({
      organizationId: org.id,
      q: params.q,
      status: params.status,
      clientId: params.clientId,
      page: Number(params.page) || 1,
    }),
    estimateSummary(org.id),
  ]);

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const writable = can(user, "estimates:write");
  const isFiltered = Boolean(params.q || params.status || params.clientId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Estimates"
        description={`${summary.pendingCount} awaiting a decision · ${money(summary.pendingCents)} out`}
        actions={
          writable ? (
            <Link href="/estimates/new" className={buttonClasses("primary", "md")}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              New estimate
            </Link>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Drafts" value={String(summary.draftCount)} />
        <Stat
          label="Out for decision"
          value={money(summary.pendingCents)}
          sub={`${summary.pendingCount} estimate${summary.pendingCount === 1 ? "" : "s"}`}
        />
        <Stat
          label="Accepted"
          value={money(summary.acceptedCents)}
          sub={`${summary.acceptedCount} won`}
          tone="success"
        />
        <Stat
          label="Acceptance rate"
          value={
            summary.acceptanceRate === null
              ? "—"
              : `${Math.round(summary.acceptanceRate * 100)}%`
          }
          sub={
            summary.acceptanceRate === null
              ? "No decisions yet"
              : `${summary.counts.get("ACCEPTED") ?? 0} accepted · ${summary.counts.get("DECLINED") ?? 0} declined`
          }
        />
      </div>

      <ListToolbar
        searchPlaceholder="Search number, title, client or line item…"
        filters={[
          {
            name: "status",
            label: "statuses",
            options: ESTIMATE_STATUSES.map((status) => ({
              value: status,
              label: ESTIMATE_STATUS_META[status].label,
            })),
          },
        ]}
      />

      <Card className="overflow-hidden">
        {list.rows.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-5 w-5" strokeWidth={1.75} />}
            title={isFiltered ? "No matches" : "No estimates yet"}
            description={
              isFiltered
                ? "Try a different search or clear the filters."
                : "Quote a job, send it, and turn it into work when the client accepts."
            }
            action={
              !isFiltered && writable ? (
                <Link
                  href="/estimates/new"
                  className={buttonClasses("primary", "md")}
                >
                  <Plus className="h-4 w-4" strokeWidth={2} />
                  New estimate
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <Th>Number</Th>
                <Th>Client</Th>
                <Th className="hidden md:table-cell">Title</Th>
                <Th className="hidden lg:table-cell">Issued</Th>
                <Th className="hidden sm:table-cell">Valid until</Th>
                <Th align="right">Total</Th>
                <Th>Status</Th>
              </THead>

              <TBody>
                {list.rows.map((estimate) => {
                  const status = effectiveEstimateStatus(estimate);
                  const meta = ESTIMATE_STATUS_META[status];

                  return (
                    <Tr key={estimate.id}>
                      <Td className="tabular font-medium whitespace-nowrap">
                        <Link
                          href={`/estimates/${estimate.id}`}
                          className="transition-colors hover:text-brand"
                        >
                          {estimate.number}
                        </Link>
                      </Td>

                      <Td>
                        <Link
                          href={`/clients/${estimate.client.id}`}
                          className="block truncate text-ink transition-colors hover:text-brand"
                        >
                          {estimate.client.displayName}
                        </Link>
                      </Td>

                      <Td className="hidden md:table-cell">
                        <span className="block truncate text-ink-muted">
                          {estimate.title ?? "—"}
                        </span>
                      </Td>

                      <Td className="tabular hidden whitespace-nowrap text-ink-muted lg:table-cell">
                        {format(estimate.issueDate, "MMM d, yyyy")}
                      </Td>

                      <Td
                        className={cn(
                          "tabular hidden whitespace-nowrap sm:table-cell",
                          status === "EXPIRED" ? "text-warning" : "text-ink-muted",
                        )}
                      >
                        {estimate.expiresAt
                          ? format(estimate.expiresAt, "MMM d, yyyy")
                          : "—"}
                      </Td>

                      <Td
                        align="right"
                        className="tabular font-medium whitespace-nowrap"
                      >
                        {money(estimate.totalCents)}
                      </Td>

                      <Td>
                        <span className="flex items-center gap-1.5">
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                          {estimate.convertedJob ? (
                            <Link
                              href={`/jobs/${estimate.convertedJob.id}`}
                              className="tabular text-xs text-ink-subtle hover:text-brand"
                              title="Converted to a job"
                            >
                              {estimate.convertedJob.number}
                            </Link>
                          ) : null}
                        </span>
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
              pathname="/estimates"
              params={{
                q: params.q,
                status: params.status,
                clientId: params.clientId,
              }}
              itemLabel="estimates"
            />
          </>
        )}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "success";
}) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-xs">
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p
        className={cn(
          "tabular mt-1.5 text-2xl font-semibold tracking-tight",
          tone === "success" ? "text-success" : "text-ink",
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-ink-subtle">{sub}</p> : null}
    </div>
  );
}

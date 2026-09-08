import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { KanbanSquare, List, Plus, Target } from "lucide-react";

import { LeadStatusSelect } from "./status-select";
import {
  assignableUsers,
  groupByStatus,
  leadPipelineSummary,
  listLeads,
  type LeadRow,
} from "./queries";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  LEAD_STATUS_META,
  LEAD_STATUSES,
  type LeadSource,
} from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";
import { cn, formatPhone } from "@/lib/utils";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    source?: string;
    assignedTo?: string;
    view?: string;
  }>;
}) {
  const { user, org } = await requirePermission("leads:read");
  const params = await searchParams;
  const view = params.view === "list" ? "list" : "board";

  const [leads, summary, team] = await Promise.all([
    listLeads({
      organizationId: org.id,
      q: params.q,
      status: params.status,
      source: params.source,
      assignedTo: params.assignedTo,
    }),
    leadPipelineSummary(org.id),
    assignableUsers(org.id),
  ]);

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const writable = can(user, "leads:write");
  const columns = groupByStatus(leads);
  const isFiltered = Boolean(
    params.q || params.status || params.source || params.assignedTo,
  );

  const otherView = view === "board" ? "list" : "board";
  const viewHref = buildHref({ ...params, view: otherView });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        description={`${summary.openCount} open · ${money(summary.openValueCents)} in the pipeline`}
        actions={
          <>
            <Link href={viewHref} className={buttonClasses("outline", "md")}>
              {view === "board" ? (
                <List className="h-4 w-4" strokeWidth={2} />
              ) : (
                <KanbanSquare className="h-4 w-4" strokeWidth={2} />
              )}
              {view === "board" ? "List" : "Board"}
            </Link>
            {writable ? (
              <Link href="/leads/new" className={buttonClasses("primary", "md")}>
                <Plus className="h-4 w-4" strokeWidth={2} />
                New lead
              </Link>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Open leads" value={String(summary.openCount)} />
        <Stat label="Pipeline value" value={money(summary.openValueCents)} />
        <Stat
          label="Won"
          value={`${summary.wonCount}`}
          sub={money(summary.wonValueCents)}
          tone="success"
        />
        <Stat
          label="Win rate"
          value={
            summary.winRate === null
              ? "—"
              : `${Math.round(summary.winRate * 100)}%`
          }
          sub={
            summary.winRate === null
              ? "No decisions yet"
              : `${summary.wonCount} won · ${summary.lostCount} lost`
          }
        />
      </div>

      <ListToolbar
        searchPlaceholder="Search name, business, email or phone…"
        filters={[
          {
            name: "status",
            label: "statuses",
            options: LEAD_STATUSES.map((status) => ({
              value: status,
              label: `${LEAD_STATUS_META[status].label} (${summary.byStatus.get(status)?.count ?? 0})`,
            })),
          },
          {
            name: "source",
            label: "sources",
            options: LEAD_SOURCES.map((source) => ({
              value: source,
              label: LEAD_SOURCE_LABELS[source],
            })),
          },
          {
            name: "assignedTo",
            label: "owners",
            allLabel: "Anyone",
            options: team.map((member) => ({
              value: member.id,
              label: member.name,
            })),
          },
        ]}
      />

      {leads.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Target className="h-5 w-5" strokeWidth={1.75} />}
            title={isFiltered ? "No matching leads" : "No leads yet"}
            description={
              isFiltered
                ? "Try a different search or clear the filters."
                : "Track every enquiry from first contact through to won or lost."
            }
            action={
              !isFiltered && writable ? (
                <Link href="/leads/new" className={buttonClasses("primary", "md")}>
                  <Plus className="h-4 w-4" strokeWidth={2} />
                  New lead
                </Link>
              ) : null
            }
          />
        </Card>
      ) : view === "board" ? (
        <div className="scrollbar-thin -mx-4 flex gap-4 overflow-x-auto px-4 pb-2 lg:-mx-6 lg:px-6">
          {columns.map((column) => {
            const meta = LEAD_STATUS_META[column.status];
            return (
              <section
                key={column.status}
                className="flex w-72 shrink-0 flex-col rounded-card border border-line bg-surface-2"
                aria-label={meta.label}
              >
                <header className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <Badge tone={meta.tone} dot>
                      {meta.label}
                    </Badge>
                    <span className="tabular text-xs text-ink-subtle">
                      {column.leads.length}
                    </span>
                  </div>
                  {column.valueCents > 0 ? (
                    <span className="tabular text-xs font-medium text-ink-muted">
                      {money(column.valueCents)}
                    </span>
                  ) : null}
                </header>

                <div className="flex-1 space-y-2 p-2">
                  {column.leads.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-ink-subtle">
                      Nothing here
                    </p>
                  ) : (
                    column.leads.map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        money={money}
                        writable={writable}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <THead>
              <Th>Lead</Th>
              <Th className="hidden md:table-cell">Contact</Th>
              <Th className="hidden lg:table-cell">Source</Th>
              <Th className="hidden lg:table-cell">Owner</Th>
              <Th align="right">Value</Th>
              <Th className="hidden sm:table-cell">Last contact</Th>
              <Th>Status</Th>
            </THead>
            <TBody>
              {leads.map((lead) => {
                const meta =
                  LEAD_STATUS_META[asStatus(LEAD_STATUSES, lead.status, "NEW")];
                return (
                  <Tr key={lead.id}>
                    <Td>
                      <Link
                        href={`/leads/${lead.id}`}
                        className="group flex items-center gap-3"
                      >
                        <Avatar name={lead.name} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink group-hover:text-brand">
                            {lead.name}
                          </span>
                          {lead.businessName ? (
                            <span className="block truncate text-xs text-ink-subtle">
                              {lead.businessName}
                            </span>
                          ) : null}
                        </span>
                      </Link>
                    </Td>
                    <Td className="hidden md:table-cell">
                      <span className="block truncate text-ink-muted">
                        {lead.email ?? "—"}
                      </span>
                      <span className="tabular block text-xs text-ink-subtle">
                        {formatPhone(lead.phone)}
                      </span>
                    </Td>
                    <Td className="hidden text-ink-muted lg:table-cell">
                      {sourceLabel(lead.source)}
                    </Td>
                    <Td className="hidden text-ink-muted lg:table-cell">
                      {lead.assignedTo?.name ?? "Unassigned"}
                    </Td>
                    <Td align="right" className="tabular whitespace-nowrap">
                      {lead.estimatedValueCents
                        ? money(lead.estimatedValueCents)
                        : "—"}
                    </Td>
                    <Td className="hidden whitespace-nowrap text-ink-muted sm:table-cell">
                      {lead.lastContactedAt
                        ? `${formatDistanceToNow(lead.lastContactedAt)} ago`
                        : "Never"}
                    </Td>
                    <Td>
                      {writable ? (
                        <LeadStatusSelect leadId={lead.id} status={lead.status} />
                      ) : (
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function LeadCard({
  lead,
  money,
  writable,
}: {
  lead: LeadRow;
  money: (cents: number) => string;
  writable: boolean;
}) {
  const stale =
    lead.lastContactedAt === null &&
    Date.now() - lead.createdAt.getTime() > 3 * 24 * 60 * 60 * 1000;

  return (
    <article className="rounded-lg border border-line bg-surface p-3 shadow-xs transition-colors hover:border-line-strong">
      <Link href={`/leads/${lead.id}`} className="group block">
        <p className="truncate text-sm font-medium text-ink group-hover:text-brand">
          {lead.name}
        </p>
        {lead.businessName ? (
          <p className="truncate text-xs text-ink-subtle">{lead.businessName}</p>
        ) : null}
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
        {lead.estimatedValueCents ? (
          <span className="tabular font-medium text-ink">
            {money(lead.estimatedValueCents)}
          </span>
        ) : null}
        {lead.source ? <span>{sourceLabel(lead.source)}</span> : null}
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span
          className={cn(
            "truncate text-xs",
            stale ? "font-medium text-warning" : "text-ink-subtle",
          )}
          title={
            lead.lastContactedAt
              ? lead.lastContactedAt.toDateString()
              : "Never contacted"
          }
        >
          {lead.lastContactedAt
            ? `${formatDistanceToNow(lead.lastContactedAt)} ago`
            : stale
              ? "Not contacted"
              : "New"}
        </span>

        {writable ? (
          <LeadStatusSelect leadId={lead.id} status={lead.status} />
        ) : null}
      </div>

      {lead.assignedTo ? (
        <p className="mt-2 truncate text-xs text-ink-subtle">
          {lead.assignedTo.name}
        </p>
      ) : null}
    </article>
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

function sourceLabel(source: string | null) {
  if (!source) return "—";
  return LEAD_SOURCES.includes(source as LeadSource)
    ? LEAD_SOURCE_LABELS[source as LeadSource]
    : source;
}

function buildHref(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `/leads?${qs}` : "/leads";
}

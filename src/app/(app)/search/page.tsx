import type { Metadata } from "next";
import Link from "next/link";
import {
  Briefcase,
  FileText,
  Receipt,
  Search,
  Target,
  Users,
} from "lucide-react";

import { globalSearch, type SearchHit } from "./queries";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { requireContext } from "@/lib/auth";

export const metadata: Metadata = { title: "Search" };

const ICONS = {
  client: Users,
  lead: Target,
  job: Briefcase,
  estimate: FileText,
  invoice: Receipt,
} as const;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const ctx = await requireContext();
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  const results = await globalSearch(ctx, query);

  return (
    <div className="space-y-6">
      <PageHeader
        title={query ? `Results for “${query}”` : "Search"}
        description={
          query.length < 2
            ? "Type at least two characters in the search box above."
            : `${results.total} match${results.total === 1 ? "" : "es"} across ${results.groups.length} section${results.groups.length === 1 ? "" : "s"}`
        }
      />

      {query.length < 2 ? (
        <Card>
          <EmptyState
            icon={<Search className="h-5 w-5" strokeWidth={1.75} />}
            title="Search everything"
            description={`Clients, leads, ${ctx.org.labelJobPlural.toLowerCase()}, estimates and invoices — by name, number, email, phone, address or line item.`}
          />
        </Card>
      ) : results.total === 0 ? (
        <Card>
          <EmptyState
            icon={<Search className="h-5 w-5" strokeWidth={1.75} />}
            title="No matches"
            description="Try a shorter search, or part of a number like 1042."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {results.groups.map((group) => {
            const Icon = ICONS[group.kind];

            return (
              <Card key={group.kind} className="overflow-hidden">
                <div className="flex items-center gap-2 border-b border-line px-5 py-3">
                  <Icon
                    className="h-4 w-4 text-ink-subtle"
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  <h2 className="text-sm font-semibold text-ink">
                    {group.label}
                  </h2>
                  <span className="tabular text-xs text-ink-subtle">
                    {group.hits.length}
                  </span>
                </div>

                <ul className="divide-y divide-line">
                  {group.hits.map((hit) => (
                    <Row key={`${hit.kind}-${hit.id}`} hit={hit} />
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Row({ hit }: { hit: SearchHit }) {
  return (
    <li>
      <Link
        href={hit.href}
        className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">
            {hit.title}
          </span>
          {hit.subtitle ? (
            <span className="block truncate text-xs text-ink-muted">
              {hit.subtitle}
            </span>
          ) : null}
        </span>

        {hit.meta ? (
          <span className="tabular shrink-0 text-xs text-ink-subtle capitalize">
            {hit.meta}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

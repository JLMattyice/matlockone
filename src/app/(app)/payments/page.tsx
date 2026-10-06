import type { Metadata } from "next";
import Link from "next/link";
import { Pencil, Wallet } from "lucide-react";

import { listPayments } from "../invoices/queries";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type PaymentMethod,
} from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatIn } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "Payments" };

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    method?: string;
    clientId?: string;
    page?: string;
  }>;
}) {
  const { user, org } = await requirePermission("payments:read");
  const zone = await viewerTimeZone();
  const params = await searchParams;

  const list = await listPayments({
    organizationId: org.id,
    q: params.q,
    method: params.method,
    clientId: params.clientId,
    page: Number(params.page) || 1,
  });

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const isFiltered = Boolean(params.q || params.method || params.clientId);

  // Editing comes back to this same page of this same search.
  const here = new URLSearchParams(
    Object.entries({
      q: params.q,
      method: params.method,
      clientId: params.clientId,
      page: params.page,
    }).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();
  const editFrom = can(user, "payments:record")
    ? `/payments${here ? `?${here}` : ""}`
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description={`${list.total} payment${list.total === 1 ? "" : "s"} · ${money(list.totalCents)} received`}
      />

      <ListToolbar
        searchPlaceholder="Search reference, invoice or client…"
        filters={[
          {
            name: "method",
            label: "methods",
            options: PAYMENT_METHODS.map((method) => ({
              value: method,
              label: PAYMENT_METHOD_LABELS[method],
            })),
          },
        ]}
      />

      <Card className="overflow-hidden">
        {list.rows.length === 0 ? (
          <EmptyState
            icon={<Wallet className="h-5 w-5" strokeWidth={1.75} />}
            title={isFiltered ? "No matches" : "No payments recorded"}
            description={
              isFiltered
                ? "Try a different search or clear the filters."
                : "Payments are recorded against an invoice and appear here."
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <Th>Received</Th>
                <Th>Client</Th>
                <Th>Invoice</Th>
                <Th className="hidden sm:table-cell">Method</Th>
                <Th className="hidden lg:table-cell">Reference</Th>
                <Th className="hidden xl:table-cell">Recorded by</Th>
                <Th align="right">Amount</Th>
                {editFrom ? (
                  <Th align="right">
                    <span className="sr-only">Edit</span>
                  </Th>
                ) : null}
              </THead>

              <TBody>
                {list.rows.map((payment) => (
                  <Tr key={payment.id}>
                    <Td className="tabular whitespace-nowrap text-ink-muted">
                      {formatIn(payment.receivedAt, "MMM d, yyyy", zone)}
                    </Td>

                    <Td>
                      {payment.client ? (
                        <Link
                          href={`/clients/${payment.client.id}`}
                          className="block truncate text-ink transition-colors hover:text-brand"
                        >
                          {payment.client.displayName}
                        </Link>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </Td>

                    <Td className="tabular whitespace-nowrap">
                      {payment.invoice ? (
                        <Link
                          href={`/invoices/${payment.invoice.id}`}
                          className="font-medium text-ink transition-colors hover:text-brand"
                        >
                          {payment.invoice.number}
                        </Link>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </Td>

                    <Td className="hidden text-ink-muted sm:table-cell">
                      {
                        PAYMENT_METHOD_LABELS[
                          asStatus(
                            PAYMENT_METHODS,
                            payment.method,
                            "OTHER",
                          ) as PaymentMethod
                        ]
                      }
                    </Td>

                    <Td className="hidden text-ink-subtle lg:table-cell">
                      {payment.reference ?? "—"}
                    </Td>

                    <Td className="hidden text-ink-subtle xl:table-cell">
                      {payment.recordedBy?.name ?? "—"}
                    </Td>

                    <Td
                      align="right"
                      className="tabular font-medium whitespace-nowrap text-success"
                    >
                      {money(payment.amountCents)}
                    </Td>

                    {editFrom ? (
                      <Td align="right" className="whitespace-nowrap">
                        <Link
                          href={`/payments/${payment.id}/edit?back=${encodeURIComponent(editFrom)}`}
                          aria-label="Edit payment"
                          title="Edit payment"
                          className={buttonClasses("ghost", "sm", "px-2")}
                        >
                          <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </Link>
                      </Td>
                    ) : null}
                  </Tr>
                ))}
              </TBody>
            </Table>

            <Pagination
              page={list.page}
              pageCount={list.pageCount}
              total={list.total}
              pageSize={list.pageSize}
              pathname="/payments"
              params={{
                q: params.q,
                method: params.method,
                clientId: params.clientId,
              }}
              itemLabel="payments"
            />
          </>
        )}
      </Card>
    </div>
  );
}

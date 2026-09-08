import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { Wallet } from "lucide-react";

import { listPayments } from "../invoices/queries";
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
  const { org } = await requirePermission("payments:read");
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
              </THead>

              <TBody>
                {list.rows.map((payment) => (
                  <Tr key={payment.id}>
                    <Td className="tabular whitespace-nowrap text-ink-muted">
                      {format(payment.receivedAt, "MMM d, yyyy")}
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

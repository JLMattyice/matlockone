import { format } from "date-fns";

import {
  LINE_ITEM_KIND_LABELS,
  LINE_ITEM_KINDS,
  asStatus,
  type LineItemKind,
} from "@/lib/constants";
import { formatMoney, formatRate } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * The document a client actually reads.
 *
 * Rendered identically in the staff detail screen, on the public share link and
 * when printed, so what the office sees is exactly what the customer sees. The
 * organization's accent color is applied inline rather than through a token,
 * because this markup is also served on the public route, outside the app
 * layout that normally sets those variables.
 */

export type DocumentOrg = {
  name: string;
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  accentColor?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
};

export type DocumentLine = {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  taxable: boolean;
  totalCents: number;
};

export type DocumentTotals = {
  subtotalCents: number;
  discountCents: number;
  taxRateBp: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents?: number;
  balanceCents?: number;
};

export function DocumentView({
  org,
  kind,
  number,
  title,
  issueDate,
  secondaryDateLabel,
  secondaryDate,
  clientName,
  address,
  lines,
  totals,
  notes,
  terms,
  currency,
  locale,
}: {
  org: DocumentOrg;
  kind: "Estimate" | "Invoice";
  number: string;
  title?: string | null;
  issueDate: Date;
  secondaryDateLabel?: string;
  secondaryDate?: Date | null;
  clientName: string;
  address?: {
    line1: string;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  } | null;
  lines: DocumentLine[];
  totals: DocumentTotals;
  notes?: string | null;
  terms?: string | null;
  currency: string;
  locale: string;
}) {
  const money = (cents: number) => formatMoney(cents, currency, locale);
  const accent = org.accentColor ?? "#0f172a";

  const orgAddress = [
    org.addressLine1,
    org.addressLine2,
    [org.city, org.state, org.postalCode].filter(Boolean).join(" "),
  ].filter(Boolean);

  return (
    <article className="bg-surface p-6 sm:p-10">
      {/* -------------------------------------------------------- letterhead --- */}
      <header className="flex flex-col gap-6 border-b border-line pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          {org.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={org.logoUrl}
              alt=""
              className="h-12 w-12 rounded-lg object-cover"
            />
          ) : null}
          <div>
            <p
              className="text-lg font-semibold tracking-tight"
              style={{ color: accent }}
            >
              {org.name}
            </p>
            {orgAddress.map((line) => (
              <p key={line} className="text-sm text-ink-muted">
                {line}
              </p>
            ))}
            <p className="mt-1 text-sm text-ink-muted">
              {[org.phone, org.email].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>

        <div className="sm:text-right">
          <p
            className="text-2xl font-semibold tracking-tight uppercase"
            style={{ color: accent }}
          >
            {kind}
          </p>
          <p className="tabular mt-0.5 text-sm font-medium text-ink">{number}</p>
          <p className="tabular mt-2 text-sm text-ink-muted">
            Issued {format(issueDate, "MMMM d, yyyy")}
          </p>
          {secondaryDate ? (
            <p className="tabular text-sm text-ink-muted">
              {secondaryDateLabel} {format(secondaryDate, "MMMM d, yyyy")}
            </p>
          ) : null}
        </div>
      </header>

      {/* ------------------------------------------------------------ recipient --- */}
      <section className="flex flex-wrap justify-between gap-6 py-6">
        <div>
          <p className="mb-1 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
            Prepared for
          </p>
          <p className="font-medium text-ink">{clientName}</p>
          {address ? (
            <>
              <p className="text-sm text-ink-muted">
                {address.line1}
                {address.line2 ? `, ${address.line2}` : ""}
              </p>
              <p className="text-sm text-ink-muted">
                {[address.city, address.state, address.postalCode]
                  .filter(Boolean)
                  .join(" ")}
              </p>
            </>
          ) : null}
        </div>

        {title ? (
          <div className="max-w-sm sm:text-right">
            <p className="mb-1 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
              Regarding
            </p>
            <p className="font-medium text-ink">{title}</p>
          </div>
        ) : null}
      </section>

      {/* ----------------------------------------------------------- line items --- */}
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-y border-line">
              <th className="py-2.5 pr-3 text-left text-xs font-semibold tracking-wide text-ink-muted uppercase">
                Description
              </th>
              <th className="px-3 py-2.5 text-right text-xs font-semibold tracking-wide text-ink-muted uppercase">
                Qty
              </th>
              <th className="px-3 py-2.5 text-right text-xs font-semibold tracking-wide text-ink-muted uppercase">
                Price
              </th>
              <th className="py-2.5 pl-3 text-right text-xs font-semibold tracking-wide text-ink-muted uppercase">
                Amount
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-line">
            {lines.map((line) => {
              const kindLabel =
                LINE_ITEM_KIND_LABELS[
                  asStatus(LINE_ITEM_KINDS, line.kind, "SERVICE") as LineItemKind
                ];

              return (
                <tr key={line.id}>
                  <td className="py-3 pr-3">
                    <p className="font-medium text-ink">{line.name}</p>
                    {line.description ? (
                      <p className="text-xs text-ink-muted">{line.description}</p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-ink-subtle">
                      {kindLabel}
                      {!line.taxable ? " · not taxed" : ""}
                    </p>
                  </td>
                  <td className="tabular px-3 py-3 text-right whitespace-nowrap text-ink-muted">
                    {line.quantity} {line.unit}
                  </td>
                  <td className="tabular px-3 py-3 text-right whitespace-nowrap text-ink-muted">
                    {money(line.unitPriceCents)}
                  </td>
                  <td className="tabular py-3 pl-3 text-right font-medium whitespace-nowrap text-ink">
                    {money(line.totalCents)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* --------------------------------------------------------------- totals --- */}
      <div className="mt-6 flex justify-end">
        <dl className="w-full max-w-xs space-y-2 text-sm">
          <TotalRow label="Subtotal">{money(totals.subtotalCents)}</TotalRow>

          {totals.discountCents > 0 ? (
            <TotalRow label="Discount">−{money(totals.discountCents)}</TotalRow>
          ) : null}

          {totals.taxCents > 0 || totals.taxRateBp > 0 ? (
            <TotalRow label={`Tax (${formatRate(totals.taxRateBp)})`}>
              {money(totals.taxCents)}
            </TotalRow>
          ) : null}

          <div
            className="flex items-center justify-between gap-4 border-t pt-2"
            style={{ borderColor: accent }}
          >
            <dt className="font-semibold text-ink">Total</dt>
            <dd
              className="tabular text-lg font-semibold"
              style={{ color: accent }}
            >
              {money(totals.totalCents)}
            </dd>
          </div>

          {totals.amountPaidCents !== undefined &&
          totals.amountPaidCents > 0 ? (
            <TotalRow label="Paid">−{money(totals.amountPaidCents)}</TotalRow>
          ) : null}

          {totals.balanceCents !== undefined ? (
            <div className="flex items-center justify-between gap-4 border-t border-line pt-2">
              <dt className="font-semibold text-ink">Balance due</dt>
              <dd
                className={cn(
                  "tabular text-lg font-semibold",
                  totals.balanceCents > 0 ? "text-ink" : "text-success",
                )}
              >
                {money(totals.balanceCents)}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      {/* ------------------------------------------------------ notes and terms --- */}
      {notes || terms ? (
        <footer className="mt-8 space-y-4 border-t border-line pt-6">
          {notes ? (
            <div>
              <p className="mb-1 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
                Notes
              </p>
              <p className="text-sm whitespace-pre-wrap text-ink-muted">
                {notes}
              </p>
            </div>
          ) : null}

          {terms ? (
            <p className="text-xs whitespace-pre-wrap text-ink-subtle">{terms}</p>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

function TotalRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular font-medium text-ink">{children}</dd>
    </div>
  );
}

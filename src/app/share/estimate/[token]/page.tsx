import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Check, Clock, X } from "lucide-react";

import { MarkViewed, RespondPanel } from "./respond";
import { getEstimateByToken } from "@/app/(app)/estimates/queries";
import { DocumentView } from "@/components/documents/document-view";
import { PrintButton } from "@/components/documents/print-button";
import { effectiveEstimateStatus, isEstimateOpen } from "@/lib/documents";
import { hexToRgbChannels } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Your estimate",
  // A quote is not something to index or hand to a link previewer.
  robots: { index: false, follow: false },
};

export default async function PublicEstimatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const estimate = await getEstimateByToken(token);

  if (!estimate) notFound();

  const org = estimate.organization;
  const status = effectiveEstimateStatus(estimate);
  const open = isEstimateOpen(status);
  const brand = hexToRgbChannels(org.primaryColor) ? org.primaryColor : "#2563eb";

  return (
    <div
      style={{ "--brand": brand } as React.CSSProperties}
      className="min-h-screen bg-surface-2 px-4 py-8 sm:py-12"
    >
      <MarkViewed token={token} />

      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 no-print">
          <div>
            <p className="text-sm text-ink-muted">
              Estimate from{" "}
              <span className="font-medium text-ink">{org.name}</span>
            </p>
            <p className="tabular text-xs text-ink-subtle">{estimate.number}</p>
          </div>
          <PrintButton label="Print or save PDF" />
        </div>

        <StatusBanner
          status={status}
          expiresAt={estimate.expiresAt}
          acceptedAt={estimate.acceptedAt}
          declinedAt={estimate.declinedAt}
        />

        <div className="overflow-hidden rounded-card border border-line shadow-xs">
          <DocumentView
            org={org}
            kind="Estimate"
            number={estimate.number}
            title={estimate.title}
            issueDate={estimate.issueDate}
            secondaryDateLabel="Valid until"
            secondaryDate={estimate.expiresAt}
            clientName={estimate.client.displayName}
            address={estimate.address}
            lines={estimate.lineItems}
            totals={{
              subtotalCents: estimate.subtotalCents,
              discountCents: estimate.discountCents,
              taxRateBp: estimate.taxRateBp,
              taxCents: estimate.taxCents,
              totalCents: estimate.totalCents,
            }}
            notes={estimate.notes}
            terms={estimate.terms ?? org.estimateFooter}
            currency={org.currency}
            locale={org.locale}
          />
        </div>

        {open ? (
          <div className="no-print">
            <RespondPanel token={token} brandColor={brand} />
          </div>
        ) : null}

        <footer className="pt-2 pb-6 text-center text-xs text-ink-subtle no-print">
          Questions? Contact {org.name}
          {org.phone ? ` on ${org.phone}` : ""}
          {org.email ? ` or at ${org.email}` : ""}.
        </footer>
      </div>
    </div>
  );
}

function StatusBanner({
  status,
  expiresAt,
  acceptedAt,
  declinedAt,
}: {
  status: string;
  expiresAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
}) {
  if (status === "ACCEPTED") {
    return (
      <Banner tone="success" icon={<Check className="h-4 w-4" strokeWidth={2.5} />}>
        You accepted this estimate
        {acceptedAt ? ` on ${format(acceptedAt, "MMMM d, yyyy")}` : ""}. We will
        be in touch to arrange the work.
      </Banner>
    );
  }

  if (status === "DECLINED") {
    return (
      <Banner tone="neutral" icon={<X className="h-4 w-4" strokeWidth={2.5} />}>
        You declined this estimate
        {declinedAt ? ` on ${format(declinedAt, "MMMM d, yyyy")}` : ""}. Get in
        touch if anything changes.
      </Banner>
    );
  }

  if (status === "EXPIRED") {
    return (
      <Banner tone="warning" icon={<Clock className="h-4 w-4" strokeWidth={2.5} />}>
        This estimate expired
        {expiresAt ? ` on ${format(expiresAt, "MMMM d, yyyy")}` : ""}. Contact us
        and we will send an updated quote.
      </Banner>
    );
  }

  if (expiresAt) {
    return (
      <Banner tone="info" icon={<Clock className="h-4 w-4" strokeWidth={2.5} />}>
        This estimate is valid until {format(expiresAt, "MMMM d, yyyy")}.
      </Banner>
    );
  }

  return null;
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: "success" | "warning" | "info" | "neutral";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const classes = {
    success: "border-success/30 bg-success/10 text-success",
    warning: "border-warning/30 bg-warning/10 text-warning",
    info: "border-info/25 bg-info/8 text-info",
    neutral: "border-line bg-surface-3 text-ink-muted",
  }[tone];

  return (
    <div
      className={`flex items-start gap-2.5 rounded-card border px-4 py-3 text-sm ${classes}`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <p>{children}</p>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Eye,
  Pencil,
  Send,
  X,
} from "lucide-react";

import { ConvertToJob, CopyLink, SendEstimate } from "./estimate-actions";
import { PrintButton } from "@/components/documents/print-button";
import {
  deleteEstimate,
  duplicateEstimate,
  setEstimateResponse,
} from "../actions";
import { getEstimate } from "../queries";
import { NotesPanel } from "@/components/notes/notes-panel";
import { DocumentView } from "@/components/documents/document-view";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { getContext, requirePermission } from "@/lib/auth";
import { ESTIMATE_STATUS_META } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { effectiveEstimateStatus } from "@/lib/documents";
import { publicUrl } from "@/lib/messaging";
import { can } from "@/lib/permissions";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const ctx = await getContext();
  if (!ctx) return { title: "Estimate" };

  const { id } = await params;
  const estimate = await prisma.estimate.findFirst({
    where: { id, organizationId: ctx.org.id },
    select: { number: true },
  });

  return { title: estimate ? `Estimate ${estimate.number}` : "Estimate" };
}

export default async function EstimateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, org } = await requirePermission("estimates:read");
  const { id } = await params;
  const estimate = await getEstimate(org.id, id);

  const status = effectiveEstimateStatus(estimate);
  const meta = ESTIMATE_STATUS_META[status];

  const writable = can(user, "estimates:write");
  const sendable = can(user, "estimates:send");
  const editable = writable && status !== "ACCEPTED" && status !== "DECLINED";
  const shareUrl = publicUrl(`/share/estimate/${estimate.publicToken}`);

  return (
    <div className="space-y-6">
      <div className="no-print">
        <Link
          href="/estimates"
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Estimates
        </Link>
      </div>

      {/* -------------------------------------------------------- toolbar --- */}
      <Card className="no-print">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular text-sm font-medium text-ink-subtle">
                {estimate.number}
              </span>
              <Badge tone={meta.tone} dot>
                {meta.label}
              </Badge>
              {estimate.convertedJob ? (
                <Link
                  href={`/jobs/${estimate.convertedJob.id}`}
                  className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
                >
                  {org.labelJobSingular} {estimate.convertedJob.number}
                  <ArrowRight className="h-3 w-3" strokeWidth={2} />
                </Link>
              ) : null}
            </div>

            <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-ink">
              {estimate.title ?? `Estimate for ${estimate.client.displayName}`}
            </h1>

            <Timeline estimate={estimate} />
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <PrintButton />

            {editable ? (
              <Link
                href={`/estimates/${estimate.id}/edit`}
                className={buttonClasses("outline", "md")}
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                Edit
              </Link>
            ) : null}

            {writable ? (
              <form action={duplicateEstimate}>
                <input type="hidden" name="id" value={estimate.id} />
                <button type="submit" className={buttonClasses("outline", "md")}>
                  <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                  Duplicate
                </button>
              </form>
            ) : null}

            {writable &&
            !estimate.convertedJobId &&
            estimate.invoices.length === 0 &&
            can(user, "estimates:delete") ? (
              <form action={deleteEstimate}>
                <input type="hidden" name="id" value={estimate.id} />
                <ConfirmButton variant="ghost" size="md" confirmLabel="Delete?">
                  Delete
                </ConfirmButton>
              </form>
            ) : null}
          </div>
        </div>

        {/* ------------------------------------------------- action strip --- */}
        {sendable || writable ? (
          <div className="space-y-3 border-t border-line bg-surface-2 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {sendable ? (
                <SendEstimate
                  estimateId={estimate.id}
                  defaultEmail={estimate.client.email}
                  alreadySent={Boolean(estimate.sentAt)}
                />
              ) : null}

              {writable && status !== "ACCEPTED" ? (
                <form action={setEstimateResponse}>
                  <input type="hidden" name="id" value={estimate.id} />
                  <input type="hidden" name="decision" value="ACCEPTED" />
                  <button
                    type="submit"
                    className={buttonClasses("outline", "md")}
                    title="Record that the client accepted"
                  >
                    <Check className="h-3.5 w-3.5" strokeWidth={2} />
                    Mark accepted
                  </button>
                </form>
              ) : null}

              {writable && status !== "DECLINED" ? (
                <form action={setEstimateResponse}>
                  <input type="hidden" name="id" value={estimate.id} />
                  <input type="hidden" name="decision" value="DECLINED" />
                  <button
                    type="submit"
                    className={buttonClasses("ghost", "md")}
                    title="Record that the client declined"
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2} />
                    Mark declined
                  </button>
                </form>
              ) : null}

              {writable && status === "ACCEPTED" && !estimate.convertedJobId ? (
                <ConvertToJob
                  estimateId={estimate.id}
                  jobLabel={org.labelJobSingular}
                />
              ) : null}
            </div>

            <div>
              <p className="mb-1.5 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
                Client link
              </p>
              <CopyLink url={shareUrl} />
              <p className="mt-1.5 text-xs text-ink-subtle">
                Anyone with this link can view and respond. It marks the estimate
                as viewed the first time it is opened.
              </p>
            </div>
          </div>
        ) : null}
      </Card>

      {/* ------------------------------------------------------- document --- */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
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
            terms={estimate.terms}
            currency={org.currency}
            locale={org.locale}
          />
        </Card>

        <div className="space-y-6 no-print">
          <Card>
            <CardHeader title="Details" />
            <dl className="divide-y divide-line text-sm">
              <Row label="Client">
                <Link
                  href={`/clients/${estimate.client.id}`}
                  className="text-brand hover:underline"
                >
                  {estimate.client.displayName}
                </Link>
              </Row>
              <Row label="Created">
                {format(estimate.createdAt, "MMM d, yyyy")}
                {estimate.createdBy ? ` by ${estimate.createdBy.name}` : ""}
              </Row>
              <Row label="Lines">{estimate.lineItems.length}</Row>
              {estimate.declineReason ? (
                <Row label="Decline reason">{estimate.declineReason}</Row>
              ) : null}
            </dl>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Internal notes" />
            <NotesPanel
              notes={estimate.notes_}
              entityType="estimate"
              entityId={estimate.id}
              canWrite={writable}
              placeholder="Anything the team should know about this quote…"
              emptyDescription="These stay internal — the client never sees them."
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

function Timeline({
  estimate,
}: {
  estimate: {
    sentAt: Date | null;
    viewedAt: Date | null;
    acceptedAt: Date | null;
    declinedAt: Date | null;
  };
}) {
  const events = [
    estimate.sentAt && { icon: Send, label: "Sent", at: estimate.sentAt },
    estimate.viewedAt && { icon: Eye, label: "Viewed", at: estimate.viewedAt },
    estimate.acceptedAt && {
      icon: Check,
      label: "Accepted",
      at: estimate.acceptedAt,
    },
    estimate.declinedAt && { icon: X, label: "Declined", at: estimate.declinedAt },
  ].filter(Boolean) as { icon: typeof Send; label: string; at: Date }[];

  if (events.length === 0) {
    return (
      <p className="mt-2 text-sm text-ink-subtle">
        Not sent yet — the client has not seen this.
      </p>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {events.map(({ icon: Icon, label, at }) => (
        <span
          key={label}
          className="inline-flex items-center gap-1.5 text-xs text-ink-muted"
        >
          <Icon className="h-3.5 w-3.5 text-ink-subtle" strokeWidth={1.75} />
          {label} {format(at, "MMM d, h:mm a")}
        </span>
      ))}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-4 px-5 py-2.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{children}</dd>
    </div>
  );
}

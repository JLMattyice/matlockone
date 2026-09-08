import type { Metadata } from "next";
import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Mail,
  Pencil,
  Phone,
  PhoneCall,
  UserPlus,
} from "lucide-react";

import {
  convertLeadToClient,
  deleteLead,
  logLeadContact,
  setLeadStatus,
} from "../actions";
import { getLead } from "../queries";
import { NotesPanel } from "@/components/notes/notes-panel";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { getContext, requirePermission } from "@/lib/auth";
import {
  asStatus,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  LEAD_STATUS_META,
  LEAD_STATUSES,
  type LeadSource,
  type LeadStatus,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";
import { cn, formatPhone } from "@/lib/utils";

/** The happy path. LOST sits outside it and is offered separately. */
const PIPELINE: LeadStatus[] = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "ESTIMATE_SENT",
  "WON",
];

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const ctx = await getContext();
  if (!ctx) return { title: "Lead" };

  const { id } = await params;
  const lead = await prisma.lead.findFirst({
    where: { id, organizationId: ctx.org.id },
    select: { name: true },
  });

  return { title: lead?.name ?? "Lead" };
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, org } = await requirePermission("leads:read");
  const { id } = await params;
  const lead = await getLead(org.id, id);

  const writable = can(user, "leads:write");
  const canConvert = writable && can(user, "clients:write");
  const status = asStatus(LEAD_STATUSES, lead.status, "NEW") as LeadStatus;
  const meta = LEAD_STATUS_META[status];
  const stageIndex = PIPELINE.indexOf(status);

  return (
    <div className="space-y-6">
      <Link
        href="/leads"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        Leads
      </Link>

      {lead.client ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-success/30 bg-success/8 px-4 py-3">
          <Check className="h-4 w-4 shrink-0 text-success" strokeWidth={2} />
          <p className="text-sm text-ink">
            Converted to a {org.labelClientSingular.toLowerCase()}
            {lead.convertedAt
              ? ` on ${format(lead.convertedAt, "MMM d, yyyy")}`
              : ""}
            .
          </p>
          <Link
            href={`/clients/${lead.client.id}`}
            className={buttonClasses("outline", "sm", "ml-auto")}
          >
            Open {lead.client.displayName}
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
          </Link>
        </div>
      ) : null}

      {/* -------------------------------------------------------- header --- */}
      <Card>
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
          <Avatar name={lead.name} size="lg" />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-ink">
                {lead.name}
              </h1>
              <Badge tone={meta.tone} dot>
                {meta.label}
              </Badge>
            </div>

            {lead.businessName ? (
              <p className="mt-0.5 text-sm text-ink-muted">{lead.businessName}</p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
              {lead.email ? (
                <a
                  href={`mailto:${lead.email}`}
                  className="inline-flex items-center gap-1.5 text-ink-muted transition-colors hover:text-brand"
                >
                  <Mail className="h-3.5 w-3.5 text-ink-subtle" strokeWidth={1.75} />
                  {lead.email}
                </a>
              ) : null}

              {lead.phone ? (
                <a
                  href={`tel:${lead.phone}`}
                  className="inline-flex items-center gap-1.5 text-ink-muted transition-colors hover:text-brand"
                >
                  <Phone className="h-3.5 w-3.5 text-ink-subtle" strokeWidth={1.75} />
                  {formatPhone(lead.phone)}
                </a>
              ) : null}
            </div>
          </div>

          {writable ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <form action={logLeadContact}>
                <input type="hidden" name="id" value={lead.id} />
                <button type="submit" className={buttonClasses("outline", "md")}>
                  <PhoneCall className="h-3.5 w-3.5" strokeWidth={2} />
                  Log contact
                </button>
              </form>

              <Link
                href={`/leads/${lead.id}/edit`}
                className={buttonClasses("outline", "md")}
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                Edit
              </Link>

              {canConvert && !lead.client ? (
                <form action={convertLeadToClient}>
                  <input type="hidden" name="id" value={lead.id} />
                  <button type="submit" className={buttonClasses("primary", "md")}>
                    <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
                    Convert to {org.labelClientSingular.toLowerCase()}
                  </button>
                </form>
              ) : null}

              <form action={deleteLead}>
                <input type="hidden" name="id" value={lead.id} />
                <ConfirmButton variant="ghost" size="md" confirmLabel="Delete?">
                  Delete
                </ConfirmButton>
              </form>
            </div>
          ) : null}
        </div>

        {/* ------------------------------------------------------ pipeline --- */}
        <div className="border-t border-line px-5 py-4">
          <p className="mb-3 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
            Pipeline
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            {PIPELINE.map((step, index) => {
              const stepMeta = LEAD_STATUS_META[step];
              const reached = stageIndex >= index && status !== "LOST";
              const current = status === step;

              const content = (
                <span
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
                    current
                      ? "border-brand bg-brand text-brand-ink"
                      : reached
                        ? "border-success/30 bg-success/10 text-success"
                        : "border-line bg-surface text-ink-subtle",
                    writable && !current && "hover:border-line-strong",
                  )}
                >
                  {reached && !current ? (
                    <Check className="h-3 w-3" strokeWidth={2.5} />
                  ) : null}
                  {stepMeta.label}
                </span>
              );

              if (!writable || current) {
                return <span key={step}>{content}</span>;
              }

              return (
                <form key={step} action={setLeadStatus} className="contents">
                  <input type="hidden" name="id" value={lead.id} />
                  <input type="hidden" name="status" value={step} />
                  <button type="submit" className="cursor-pointer">
                    {content}
                  </button>
                </form>
              );
            })}

            {writable && status !== "LOST" ? (
              <form action={setLeadStatus} className="contents">
                <input type="hidden" name="id" value={lead.id} />
                <input type="hidden" name="status" value="LOST" />
                <button
                  type="submit"
                  className="ml-auto cursor-pointer rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-subtle transition-colors hover:border-danger/40 hover:text-danger"
                >
                  Mark lost
                </button>
              </form>
            ) : null}

            {status === "LOST" ? (
              <span className="ml-auto flex items-center gap-2">
                <Badge tone="danger">Lost</Badge>
                {writable ? (
                  <form action={setLeadStatus} className="contents">
                    <input type="hidden" name="id" value={lead.id} />
                    <input type="hidden" name="status" value="CONTACTED" />
                    <button
                      type="submit"
                      className="cursor-pointer text-xs text-ink-muted underline-offset-2 hover:underline"
                    >
                      Reopen
                    </button>
                  </form>
                ) : null}
              </span>
            ) : null}
          </div>

          {lead.lostReason ? (
            <p className="mt-3 text-sm text-ink-muted">
              <span className="font-medium text-ink">Reason:</span>{" "}
              {lead.lostReason}
            </p>
          ) : null}
        </div>
      </Card>

      {/* ----------------------------------------------------------- body --- */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader
            title="Notes"
            description="Everything said so far, newest first."
          />
          <NotesPanel
            notes={lead.notes}
            entityType="lead"
            entityId={lead.id}
            canWrite={writable}
            placeholder="What did they ask for? What did you quote?"
            emptyDescription="Log what was discussed so whoever picks this up next has the context."
          />
        </Card>

        <Card>
          <CardHeader title="Details" />
          <dl className="divide-y divide-line text-sm">
            <Detail label="Estimated value">
              {lead.estimatedValueCents
                ? formatMoney(lead.estimatedValueCents, org.currency, org.locale)
                : "Not set"}
            </Detail>
            <Detail label="Source">
              {lead.source && LEAD_SOURCES.includes(lead.source as LeadSource)
                ? LEAD_SOURCE_LABELS[lead.source as LeadSource]
                : "Not recorded"}
            </Detail>
            <Detail label="Owner">{lead.assignedTo?.name ?? "Unassigned"}</Detail>
            <Detail label="Last contacted">
              {lead.lastContactedAt
                ? `${formatDistanceToNow(lead.lastContactedAt)} ago`
                : "Never"}
            </Detail>
            <Detail label="Created">
              {format(lead.createdAt, "MMM d, yyyy")}
              {lead.createdBy ? ` by ${lead.createdBy.name}` : ""}
            </Detail>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function Detail({
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

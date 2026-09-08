import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowLeft,
  CalendarClock,
  Globe,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Smartphone,
} from "lucide-react";

import {
  EstimatesTable,
  InvoicesTable,
  JobsTable,
  PaymentsTable,
} from "./history";
import { deleteClient, setClientStatus } from "../actions";
import {
  clientAttachments,
  clientEstimates,
  clientFinancials,
  clientInvoices,
  clientJobs,
  clientNotes,
  clientPayments,
  getClient,
} from "../queries";
import { AttachmentPanel } from "@/components/files/attachment-panel";
import { NotesPanel } from "@/components/notes/notes-panel";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/page-header";
import { TabLinks } from "@/components/ui/tab-links";
import { getContext, requirePermission } from "@/lib/auth";
import {
  asStatus,
  CLIENT_STATUS_META,
  CLIENT_STATUSES,
  JOB_STATUS_META,
  JOB_STATUSES,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  type LeadSource,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/utils";

const VIEWS = [
  "overview",
  "jobs",
  "estimates",
  "invoices",
  "payments",
  "files",
  "notes",
] as const;
type View = (typeof VIEWS)[number];

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const ctx = await getContext();
  if (!ctx) return { title: "Client" };

  const { id } = await params;
  const client = await prisma.client.findFirst({
    where: { id, organizationId: ctx.org.id },
    select: { displayName: true },
  });

  return { title: client?.displayName ?? "Client" };
}

export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { user, org } = await requirePermission("clients:read");
  const { id } = await params;
  const { view: rawView } = await searchParams;

  const client = await getClient(org.id, id);

  const seesMoney = can(user, "invoices:read");
  const writable = can(user, "clients:write");
  const deletable = can(user, "clients:delete");

  const view: View = VIEWS.includes(rawView as View)
    ? (rawView as View)
    : "overview";

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const status = asStatus(CLIENT_STATUSES, client.status, "ACTIVE");
  const statusMeta = CLIENT_STATUS_META[status];

  const financials = seesMoney ? await clientFinancials(org.id, client.id) : null;

  return (
    <div className="space-y-6">
      <Link
        href="/clients"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        {org.labelClientPlural}
      </Link>

      {/* -------------------------------------------------------- header --- */}
      <Card>
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
          <Avatar
            name={client.displayName}
            isBusiness={client.type === "BUSINESS"}
            size="lg"
          />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-ink">
                {client.displayName}
              </h1>
              <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
              {client.taxExempt ? <Badge tone="info">Tax exempt</Badge> : null}
            </div>

            {client.type === "BUSINESS" &&
            (client.firstName || client.lastName) ? (
              <p className="mt-0.5 text-sm text-ink-muted">
                Contact: {[client.firstName, client.lastName].filter(Boolean).join(" ")}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
              {client.email ? (
                <ContactLink
                  href={`mailto:${client.email}`}
                  icon={<Mail className="h-3.5 w-3.5" strokeWidth={1.75} />}
                >
                  {client.email}
                </ContactLink>
              ) : null}

              {client.phone ? (
                <ContactLink
                  href={`tel:${client.phone}`}
                  icon={<Phone className="h-3.5 w-3.5" strokeWidth={1.75} />}
                >
                  {formatPhone(client.phone)}
                </ContactLink>
              ) : null}

              {client.mobilePhone ? (
                <ContactLink
                  href={`tel:${client.mobilePhone}`}
                  icon={<Smartphone className="h-3.5 w-3.5" strokeWidth={1.75} />}
                >
                  {formatPhone(client.mobilePhone)}
                </ContactLink>
              ) : null}

              {client.website ? (
                <ContactLink
                  href={client.website}
                  icon={<Globe className="h-3.5 w-3.5" strokeWidth={1.75} />}
                >
                  Website
                </ContactLink>
              ) : null}
            </div>
          </div>

          {writable ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Link
                href={`/clients/${client.id}/edit`}
                className={buttonClasses("outline", "md")}
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                Edit
              </Link>

              <form action={setClientStatus}>
                <input type="hidden" name="id" value={client.id} />
                <input
                  type="hidden"
                  name="status"
                  value={status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED"}
                />
                <button type="submit" className={buttonClasses("ghost", "md")}>
                  {status === "ARCHIVED" ? "Restore" : "Archive"}
                </button>
              </form>

              {deletable ? (
                <form action={deleteClient}>
                  <input type="hidden" name="id" value={client.id} />
                  <ConfirmButton variant="ghost" size="md" confirmLabel="Delete?">
                    Delete
                  </ConfirmButton>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>

        {financials ? (
          <div className="grid grid-cols-2 divide-line border-t border-line sm:grid-cols-4 sm:divide-x">
            <Figure label="Invoiced" value={money(financials.invoicedCents)} />
            <Figure
              label="Paid"
              value={money(financials.paidCents)}
              tone="success"
            />
            <Figure
              label="Outstanding"
              value={money(financials.outstandingCents)}
              tone={financials.outstandingCents > 0 ? "warning" : undefined}
            />
            <Figure
              label="Open invoices"
              value={String(financials.openInvoiceCount)}
            />
          </div>
        ) : null}
      </Card>

      {/* ---------------------------------------------------------- tabs --- */}
      <TabLinks
        tabs={[
          tab(client.id, "overview", "Overview", view),
          tab(client.id, "jobs", org.labelJobPlural, view, client._count.jobs),
          ...(seesMoney
            ? [
                tab(
                  client.id,
                  "estimates",
                  "Estimates",
                  view,
                  client._count.estimates,
                ),
                tab(client.id, "invoices", "Invoices", view, client._count.invoices),
                tab(client.id, "payments", "Payments", view, client._count.payments),
              ]
            : []),
          ...(can(user, "files:read")
            ? [tab(client.id, "files", "Files", view, client._count.attachments)]
            : []),
          tab(client.id, "notes", "Notes", view, client._count.notes),
        ]}
      />

      {view === "overview" ? (
        <Overview
          client={client}
          org={org}
          jobLabel={org.labelJobPlural}
          seesMoney={seesMoney}
        />
      ) : null}

      {view === "jobs" ? (
        <Card className="overflow-hidden">
          <JobsTable
            jobs={await clientJobs(org.id, client.id)}
            jobLabel={org.labelJobPlural}
          />
        </Card>
      ) : null}

      {view === "estimates" && seesMoney ? (
        <Card className="overflow-hidden">
          <EstimatesTable
            estimates={await clientEstimates(org.id, client.id)}
            currency={org.currency}
            locale={org.locale}
          />
        </Card>
      ) : null}

      {view === "invoices" && seesMoney ? (
        <Card className="overflow-hidden">
          <InvoicesTable
            invoices={await clientInvoices(org.id, client.id)}
            currency={org.currency}
            locale={org.locale}
          />
        </Card>
      ) : null}

      {view === "payments" && seesMoney ? (
        <Card className="overflow-hidden">
          <PaymentsTable
            payments={await clientPayments(org.id, client.id)}
            currency={org.currency}
            locale={org.locale}
          />
        </Card>
      ) : null}

      {view === "files" && can(user, "files:read") ? (
        <Card className="overflow-hidden">
          <AttachmentPanel
            attachments={await clientAttachments(org.id, client.id)}
            entityType="client"
            entityId={client.id}
            canWrite={can(user, "files:write")}
          />
        </Card>
      ) : null}

      {view === "notes" ? (
        <Card className="overflow-hidden">
          <NotesPanel
            notes={await clientNotes(org.id, client.id)}
            entityType="client"
            entityId={client.id}
            canWrite={writable}
            placeholder="Gate codes, access instructions, preferences, anything the team should know…"
            emptyDescription="Notes are internal unless you mark one client-visible."
          />
        </Card>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------- overview ---

async function Overview({
  client,
  org,
  jobLabel,
  seesMoney,
}: {
  client: Awaited<ReturnType<typeof getClient>>;
  org: { id: string; currency: string; locale: string; labelJobPlural: string };
  jobLabel: string;
  seesMoney: boolean;
}) {
  const [upcoming, recentJobs, recentInvoices, notes] = await Promise.all([
    clientJobs(org.id, client.id, { upcomingOnly: true, take: 5 }),
    clientJobs(org.id, client.id, { take: 5 }),
    seesMoney ? clientInvoices(org.id, client.id, 5) : Promise.resolve([]),
    clientNotes(org.id, client.id),
  ]);

  const pinned = notes.filter((note) => note.pinned).slice(0, 3);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card className="overflow-hidden">
          <CardHeader
            title="Upcoming"
            description={`Scheduled ${jobLabel.toLowerCase()} and appointments`}
          />
          {upcoming.length === 0 ? (
            <EmptyState
              icon={<CalendarClock className="h-5 w-5" strokeWidth={1.75} />}
              title="Nothing scheduled"
              description={`This client has no upcoming ${jobLabel.toLowerCase()}.`}
            />
          ) : (
            <ul className="divide-y divide-line">
              {upcoming.map((job) => {
                const meta =
                  JOB_STATUS_META[asStatus(JOB_STATUSES, job.status, "SCHEDULED")];
                return (
                  <li
                    key={job.id}
                    className="flex items-start gap-4 px-5 py-3.5"
                  >
                    <div className="w-20 shrink-0">
                      <p className="text-xs font-medium text-ink">
                        {job.scheduledStart
                          ? format(job.scheduledStart, "EEE, MMM d")
                          : "Unscheduled"}
                      </p>
                      <p className="tabular text-xs text-ink-subtle">
                        {job.scheduledStart && !job.allDay
                          ? format(job.scheduledStart, "h:mm a")
                          : job.allDay
                            ? "All day"
                            : ""}
                      </p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">
                        {job.title}
                      </p>
                      <p className="truncate text-xs text-ink-subtle">
                        {job.assignments.map((a) => a.user.name).join(", ") ||
                          "Unassigned"}
                      </p>
                    </div>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title={`Recent ${jobLabel.toLowerCase()}`}
            action={
              <Link
                href={`/clients/${client.id}?view=jobs`}
                className={buttonClasses("ghost", "sm")}
              >
                View all
              </Link>
            }
          />
          <JobsTable jobs={recentJobs} jobLabel={jobLabel} />
        </Card>

        {seesMoney ? (
          <Card className="overflow-hidden">
            <CardHeader
              title="Recent invoices"
              action={
                <Link
                  href={`/clients/${client.id}?view=invoices`}
                  className={buttonClasses("ghost", "sm")}
                >
                  View all
                </Link>
              }
            />
            <InvoicesTable
              invoices={recentInvoices}
              currency={org.currency}
              locale={org.locale}
            />
          </Card>
        ) : null}
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader title="Addresses" />
          {client.addresses.length === 0 ? (
            <EmptyState
              icon={<MapPin className="h-5 w-5" strokeWidth={1.75} />}
              title="No address on file"
            />
          ) : (
            <ul className="divide-y divide-line">
              {client.addresses.map((address) => (
                <li key={address.id} className="px-5 py-3.5">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-ink">
                      {address.label ?? "Address"}
                    </span>
                    {address.isPrimary ? (
                      <Badge tone="accent">Primary</Badge>
                    ) : null}
                    {address.isBilling ? <Badge>Billing</Badge> : null}
                  </div>
                  <p className="text-sm text-ink-muted">
                    {address.line1}
                    {address.line2 ? `, ${address.line2}` : ""}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {[address.city, address.state, address.postalCode]
                      .filter(Boolean)
                      .join(" ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Details" />
          <dl className="divide-y divide-line text-sm">
            <Detail label="Type">
              {client.type === "BUSINESS" ? "Business" : "Individual"}
            </Detail>
            <Detail label="Source">
              {client.source && LEAD_SOURCES.includes(client.source as LeadSource)
                ? LEAD_SOURCE_LABELS[client.source as LeadSource]
                : "Not recorded"}
            </Detail>
            <Detail label="Added">
              {format(client.createdAt, "MMM d, yyyy")}
              {client.createdBy ? ` by ${client.createdBy.name}` : ""}
            </Detail>
            <Detail label="Last updated">
              {format(client.updatedAt, "MMM d, yyyy")}
            </Detail>
          </dl>
        </Card>

        {pinned.length ? (
          <Card>
            <CardHeader
              title="Pinned notes"
              action={
                <Link
                  href={`/clients/${client.id}?view=notes`}
                  className={buttonClasses("ghost", "sm")}
                >
                  All notes
                </Link>
              }
            />
            <ul className="divide-y divide-line">
              {pinned.map((note) => (
                <li key={note.id} className="px-5 py-3.5">
                  <p className="text-sm whitespace-pre-wrap text-ink-muted">
                    {note.body}
                  </p>
                  <p className="mt-1.5 text-xs text-ink-subtle">
                    {note.author?.name ?? "Removed user"} ·{" "}
                    {format(note.createdAt, "MMM d, yyyy")}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- pieces ---

function tab(
  clientId: string,
  view: View,
  label: string,
  active: View,
  count?: number,
) {
  return {
    href:
      view === "overview"
        ? `/clients/${clientId}`
        : `/clients/${clientId}?view=${view}`,
    label,
    count,
    active: active === view,
  };
}

function ContactLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 text-ink-muted transition-colors hover:text-brand"
    >
      <span className="text-ink-subtle">{icon}</span>
      {children}
    </a>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "warning";
}) {
  return (
    <div className="px-5 py-3.5">
      <p className="text-xs text-ink-muted">{label}</p>
      <p
        className={`tabular mt-0.5 text-lg font-semibold ${
          tone === "success"
            ? "text-success"
            : tone === "warning"
              ? "text-warning"
              : "text-ink"
        }`}
      >
        {value}
      </p>
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

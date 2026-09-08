import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Clock,
  MapPin,
  Package,
  Pencil,
  Receipt,
  Repeat,
  Trash2,
  User,
} from "lucide-react";

import { CancelJob } from "./cancel-job";
import { MaterialForm } from "./material-form";
import { TimeForm } from "./time-form";
import {
  deleteJob,
  deleteJobMaterial,
  deleteTimeEntry,
  setJobStatus,
} from "../actions";
import { createInvoiceFromJob } from "../../invoices/actions";
import { activeCrew, getJob, jobCostTotals } from "../queries";
import { AttachmentPanel } from "@/components/files/attachment-panel";
import { NotesPanel } from "@/components/notes/notes-panel";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/page-header";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getContext, requirePermission } from "@/lib/auth";
import {
  asStatus,
  JOB_PRIORITY_META,
  JOB_PRIORITIES,
  JOB_STATUS_FLOW,
  JOB_STATUS_META,
  JOB_STATUSES,
  type JobStatus,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { currencySymbol, formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";
import { describeRecurrence } from "@/lib/recurrence";
import { formatPhone, toDateTimeLocal } from "@/lib/utils";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const ctx = await getContext();
  if (!ctx) return { title: "Job" };

  const { id } = await params;
  const job = await prisma.job.findFirst({
    where: { id, organizationId: ctx.org.id },
    select: { number: true, title: true },
  });

  return { title: job ? `${job.number} · ${job.title}` : "Job" };
}

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requirePermission("jobs:read");
  const { user, org } = ctx;
  const { id } = await params;

  const job = await getJob(ctx, id);
  const crew = can(user, "jobs:assign") ? await activeCrew(org.id) : [];

  const writable = can(user, "jobs:write");
  const canLogTime = can(user, "jobs:log-time");
  const seesMoney = can(user, "invoices:read");

  const status = asStatus(JOB_STATUSES, job.status, "SCHEDULED") as JobStatus;
  const meta = JOB_STATUS_META[status];
  const priority = asStatus(JOB_PRIORITIES, job.priority, "NORMAL");
  const costs = jobCostTotals(job);
  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);

  // Cancel gets its own control, since it asks for a reason.
  const nextStatuses = (JOB_STATUS_FLOW[status] ?? []).filter(
    (next) => next !== "CANCELLED",
  );

  return (
    <div className="space-y-6">
      <Link
        href="/jobs"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        {org.labelJobPlural}
      </Link>

      {/* -------------------------------------------------------- header --- */}
      <Card>
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular text-sm font-medium text-ink-subtle">
                {job.number}
              </span>
              <Badge tone={meta.tone} dot>
                {meta.label}
              </Badge>
              {priority !== "NORMAL" ? (
                <Badge tone={JOB_PRIORITY_META[priority].tone}>
                  {JOB_PRIORITY_META[priority].label}
                </Badge>
              ) : null}
              {job.kind === "APPOINTMENT" ? <Badge>Appointment</Badge> : null}
              {job.recurrenceRule ? (
                <Badge tone="info">
                  <Repeat className="h-3 w-3" strokeWidth={2} />
                  {describeRecurrence(job.recurrenceRule)}
                </Badge>
              ) : null}
            </div>

            <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-ink">
              {job.title}
            </h1>

            {job.description ? (
              <p className="mt-2 max-w-2xl text-sm whitespace-pre-wrap text-ink-muted">
                {job.description}
              </p>
            ) : null}

            {job.cancelReason ? (
              <p className="mt-2 text-sm text-danger">
                Cancelled: {job.cancelReason}
              </p>
            ) : null}
          </div>

          {writable ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Link
                href={`/jobs/${job.id}/edit`}
                className={buttonClasses("outline", "md")}
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                Edit
              </Link>
              {can(user, "jobs:delete") ? (
                <form action={deleteJob}>
                  <input type="hidden" name="id" value={job.id} />
                  <ConfirmButton variant="ghost" size="md" confirmLabel="Delete?">
                    Delete
                  </ConfirmButton>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ------------------------------------------------- status flow --- */}
        {writable ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-2 px-5 py-3">
            <span className="text-xs font-semibold tracking-wider text-ink-subtle uppercase">
              Move to
            </span>

            {nextStatuses.map((next) => (
              <form key={next} action={setJobStatus}>
                <input type="hidden" name="id" value={job.id} />
                <input type="hidden" name="status" value={next} />
                <button
                  type="submit"
                  className={buttonClasses(
                    next === "COMPLETED" ? "primary" : "outline",
                    "sm",
                  )}
                >
                  {JOB_STATUS_META[next].label}
                  <ArrowRight className="h-3 w-3" strokeWidth={2} />
                </button>
              </form>
            ))}

            {status !== "CANCELLED" && status !== "COMPLETED" ? (
              <CancelJob jobId={job.id} />
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* ------------------------------------------------- materials --- */}
          <Card className="overflow-hidden">
            <CardHeader
              title="Materials"
              description="Parts and supplies used on this job."
              action={
                seesMoney && costs.materialsCents > 0 ? (
                  <span className="tabular text-sm font-semibold text-ink">
                    {money(costs.materialsCents)}
                  </span>
                ) : null
              }
            />

            {writable ? (
              <div className="border-b border-line p-5">
                <MaterialForm
                  jobId={job.id}
                  currencySymbol={currencySymbol(org.currency, org.locale)}
                />
              </div>
            ) : null}

            {job.materials.length === 0 ? (
              <EmptyState
                icon={<Package className="h-5 w-5" strokeWidth={1.75} />}
                title="No materials recorded"
              />
            ) : (
              <Table>
                <THead>
                  <Th>Item</Th>
                  <Th align="right">Qty</Th>
                  {seesMoney ? <Th align="right">Unit</Th> : null}
                  {seesMoney ? <Th align="right">Total</Th> : null}
                  {writable ? <Th /> : null}
                </THead>
                <TBody>
                  {job.materials.map((material) => (
                    <Tr key={material.id}>
                      <Td>
                        <span className="font-medium">{material.name}</span>
                        {!material.billable ? (
                          <Badge className="ml-2">Not billable</Badge>
                        ) : null}
                      </Td>
                      <Td align="right" className="tabular whitespace-nowrap">
                        {material.quantity} {material.unit}
                      </Td>
                      {seesMoney ? (
                        <Td align="right" className="tabular text-ink-muted">
                          {money(material.unitCostCents)}
                        </Td>
                      ) : null}
                      {seesMoney ? (
                        <Td align="right" className="tabular font-medium">
                          {money(material.totalCents)}
                        </Td>
                      ) : null}
                      {writable ? (
                        <Td align="right" className="w-10">
                          <form action={deleteJobMaterial}>
                            <input type="hidden" name="id" value={material.id} />
                            <input type="hidden" name="jobId" value={job.id} />
                            <button
                              type="submit"
                              aria-label={`Remove ${material.name}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-danger/10 hover:text-danger"
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </button>
                          </form>
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          {/* ------------------------------------------------------ time --- */}
          <Card className="overflow-hidden">
            <CardHeader
              title="Labor"
              description="Hours logged against this job."
              action={
                <span className="tabular text-sm font-semibold text-ink">
                  {formatMinutes(costs.totalMinutes)}
                  {seesMoney && costs.laborCents > 0
                    ? ` · ${money(costs.laborCents)}`
                    : ""}
                </span>
              }
            />

            {canLogTime ? (
              <div className="border-b border-line p-5">
                <TimeForm
                  jobId={job.id}
                  crew={
                    crew.length
                      ? crew
                      : [{ id: user.id, name: user.name }]
                  }
                  currentUserId={user.id}
                  canLogForOthers={can(user, "jobs:assign")}
                  defaultStart={toDateTimeLocal(
                    job.scheduledStart ?? new Date(),
                  )}
                />
              </div>
            ) : null}

            {job.timeEntries.length === 0 ? (
              <EmptyState
                icon={<Clock className="h-5 w-5" strokeWidth={1.75} />}
                title="No time logged"
              />
            ) : (
              <Table>
                <THead>
                  <Th>Who</Th>
                  <Th>Started</Th>
                  <Th align="right">Time</Th>
                  {seesMoney ? <Th align="right">Cost</Th> : null}
                  {canLogTime ? <Th /> : null}
                </THead>
                <TBody>
                  {job.timeEntries.map((entry) => (
                    <Tr key={entry.id}>
                      <Td>
                        <span className="font-medium">{entry.user.name}</span>
                        {entry.notes ? (
                          <span className="block truncate text-xs text-ink-subtle">
                            {entry.notes}
                          </span>
                        ) : null}
                      </Td>
                      <Td className="tabular whitespace-nowrap text-ink-muted">
                        {format(entry.startedAt, "MMM d, h:mm a")}
                      </Td>
                      <Td align="right" className="tabular whitespace-nowrap">
                        {formatMinutes(entry.minutes)}
                      </Td>
                      {seesMoney ? (
                        <Td align="right" className="tabular font-medium">
                          {entry.billable
                            ? money(
                                Math.round(
                                  (entry.minutes / 60) * entry.hourlyRateCents,
                                ),
                              )
                            : "—"}
                        </Td>
                      ) : null}
                      {canLogTime ? (
                        <Td align="right" className="w-10">
                          <form action={deleteTimeEntry}>
                            <input type="hidden" name="id" value={entry.id} />
                            <input type="hidden" name="jobId" value={job.id} />
                            <button
                              type="submit"
                              aria-label="Remove time entry"
                              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-danger/10 hover:text-danger"
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </button>
                          </form>
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          {/* ----------------------------------------------- attachments --- */}
          {can(user, "files:read") ? (
            <Card className="overflow-hidden">
              <CardHeader
                title="Photos & documents"
                description="Before-and-after shots, signed paperwork, anything from site."
              />
              <AttachmentPanel
                attachments={job.attachments}
                entityType="job"
                entityId={job.id}
                canWrite={can(user, "files:write")}
                allowPhotoStage
              />
            </Card>
          ) : null}

          {/* ----------------------------------------------------- notes --- */}
          <Card className="overflow-hidden">
            <CardHeader title="Notes" />
            <NotesPanel
              notes={job.notes}
              entityType="job"
              entityId={job.id}
              canWrite={canLogTime}
              placeholder="What was found on site? What still needs doing?"
            />
          </Card>
        </div>

        {/* ------------------------------------------------------ sidebar --- */}
        <div className="space-y-6">
          <Card>
            <CardHeader title="Schedule" />
            <div className="space-y-3 px-5 py-4">
              {job.scheduledStart ? (
                <div className="flex items-start gap-2.5">
                  <CalendarClock
                    className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle"
                    strokeWidth={1.75}
                  />
                  <div>
                    <p className="text-sm font-medium text-ink">
                      {format(job.scheduledStart, "EEEE, MMMM d, yyyy")}
                    </p>
                    <p className="tabular text-sm text-ink-muted">
                      {job.allDay
                        ? "All day"
                        : `${format(job.scheduledStart, "h:mm a")}${
                            job.scheduledEnd
                              ? ` – ${format(job.scheduledEnd, "h:mm a")}`
                              : ""
                          }`}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-warning">Not scheduled yet.</p>
              )}

              {job.startedAt ? (
                <p className="text-xs text-ink-subtle">
                  Started {format(job.startedAt, "MMM d 'at' h:mm a")}
                </p>
              ) : null}
              {job.completedAt ? (
                <p className="text-xs text-success">
                  Completed {format(job.completedAt, "MMM d 'at' h:mm a")}
                </p>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Client & location" />
            <div className="space-y-3 px-5 py-4">
              {job.client ? (
                <div className="flex items-start gap-2.5">
                  <User
                    className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle"
                    strokeWidth={1.75}
                  />
                  <div className="min-w-0">
                    <Link
                      href={`/clients/${job.client.id}`}
                      className="block truncate text-sm font-medium text-ink transition-colors hover:text-brand"
                    >
                      {job.client.displayName}
                    </Link>
                    {job.client.phone ? (
                      <a
                        href={`tel:${job.client.phone}`}
                        className="tabular block text-sm text-ink-muted hover:text-brand"
                      >
                        {formatPhone(job.client.phone)}
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-ink-subtle">No client attached.</p>
              )}

              {job.address ? (
                <div className="flex items-start gap-2.5">
                  <MapPin
                    className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle"
                    strokeWidth={1.75}
                  />
                  <p className="text-sm text-ink-muted">
                    {job.address.line1}
                    {job.address.line2 ? `, ${job.address.line2}` : ""}
                    <br />
                    {[job.address.city, job.address.state, job.address.postalCode]
                      .filter(Boolean)
                      .join(" ")}
                  </p>
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Assigned to"
              description={job.group?.name ?? undefined}
            />
            {job.assignments.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-subtle">Unassigned.</p>
            ) : (
              <ul className="divide-y divide-line">
                {job.assignments.map((assignment) => (
                  <li
                    key={assignment.id}
                    className="flex items-center gap-2 px-5 py-3"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {assignment.user.name}
                      </span>
                      {assignment.user.position ? (
                        <span className="block truncate text-xs text-ink-subtle">
                          {assignment.user.position}
                        </span>
                      ) : null}
                    </span>
                    {assignment.isLead ? <Badge tone="accent">Lead</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {seesMoney ? (
            <Card>
              <CardHeader title="Cost so far" />
              <dl className="divide-y divide-line text-sm">
                <Row label="Materials">{money(costs.materialsCents)}</Row>
                <Row label="Labor">{money(costs.laborCents)}</Row>
                <Row label="Total" strong>
                  {money(costs.totalCents)}
                </Row>
              </dl>
              <div className="border-t border-line px-5 py-3">
                <p className="mb-1.5 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
                  Invoices
                </p>

                {job.invoices.length ? (
                  job.invoices.map((invoice) => (
                    <Link
                      key={invoice.id}
                      href={`/invoices/${invoice.id}`}
                      className="tabular block text-sm text-ink-muted transition-colors hover:text-brand"
                    >
                      {invoice.number} · {money(invoice.totalCents)}
                      {invoice.balanceCents > 0
                        ? ` · ${money(invoice.balanceCents)} due`
                        : " · paid"}
                    </Link>
                  ))
                ) : status === "COMPLETED" && can(user, "invoices:write") ? (
                  <form action={createInvoiceFromJob}>
                    <input type="hidden" name="jobId" value={job.id} />
                    <button
                      type="submit"
                      className={buttonClasses("primary", "sm", "w-full")}
                    >
                      <Receipt className="h-3.5 w-3.5" strokeWidth={2} />
                      Create invoice from this {org.labelJobSingular.toLowerCase()}
                    </button>
                  </form>
                ) : (
                  <p className="text-sm text-ink-subtle">
                    {status === "COMPLETED"
                      ? "Not invoiced yet."
                      : "Complete the work to bill it."}
                  </p>
                )}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
  strong,
}: {
  label: string;
  children: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4 px-5 py-2.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd
        className={`tabular text-right ${
          strong ? "font-semibold text-ink" : "font-medium text-ink"
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

function formatMinutes(minutes: number) {
  if (minutes === 0) return "0h";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

import "server-only";

import { prisma } from "./db";
import { can, type Actor } from "./permissions";

/**
 * What happened, in the order it happened.
 *
 * The records are rows in `AuditLog`, which has been in the schema since the
 * beginning with nothing writing to it. The shape was already right — who,
 * what, which record, when — so this is a use for it rather than a new table.
 *
 * Two decisions worth knowing:
 *
 * **The sentence is written when the event happens, not when it is read.**
 * "Invoice INV-1042 sent to Oscar Nakamura" is stored as those words. Rebuilding
 * it later from joins would mean a renamed client silently rewrites history,
 * and a deleted one erases it. A timeline that changes behind you is worse than
 * no timeline.
 *
 * **Recording never fails the thing being recorded.** Sending an invoice that
 * succeeds and then reports an error because its activity row could not be
 * written would be a bug of our own making. Every failure here is swallowed.
 */

/** What kind of thing an event happened to, used to link back to it. */
export type ActivityEntity =
  | "CLIENT"
  | "LEAD"
  | "JOB"
  | "ESTIMATE"
  | "INVOICE"
  | "PAYMENT";

/**
 * The events worth putting on a timeline.
 *
 * Deliberately not everything that writes to the database. An edit to a phone
 * number is not news; an invoice going out is. A timeline that lists every
 * field change is one nobody reads, which is the same as not having one.
 */
export type ActivityAction =
  | "client.created"
  | "lead.converted"
  | "job.created"
  | "job.status"
  | "estimate.sent"
  | "estimate.accepted"
  | "estimate.declined"
  | "estimate.converted"
  | "invoice.sent"
  | "invoice.cancelled"
  | "payment.recorded"
  | "note.added"
  | "file.uploaded"
  | "task.completed";

export type ActivityTone = "brand" | "success" | "warning" | "danger" | "neutral";

/** How each event reads on screen. */
export const ACTIVITY_META: Record<
  ActivityAction,
  { icon: ActivityIcon; tone: ActivityTone }
> = {
  "client.created": { icon: "user", tone: "neutral" },
  "lead.converted": { icon: "user", tone: "success" },
  "job.created": { icon: "briefcase", tone: "brand" },
  "job.status": { icon: "briefcase", tone: "neutral" },
  "estimate.sent": { icon: "send", tone: "brand" },
  "estimate.accepted": { icon: "check", tone: "success" },
  "estimate.declined": { icon: "x", tone: "danger" },
  "estimate.converted": { icon: "briefcase", tone: "success" },
  "invoice.sent": { icon: "send", tone: "brand" },
  "invoice.cancelled": { icon: "x", tone: "warning" },
  "payment.recorded": { icon: "banknote", tone: "success" },
  "note.added": { icon: "note", tone: "neutral" },
  "file.uploaded": { icon: "paperclip", tone: "neutral" },
  "task.completed": { icon: "check", tone: "success" },
};

export type ActivityIcon =
  | "user"
  | "briefcase"
  | "send"
  | "check"
  | "x"
  | "banknote"
  | "note"
  | "paperclip";

export type ActivityInput = {
  organizationId: string;
  /** Whoever did it. Null for anything the system did on its own. */
  userId?: string | null;
  action: ActivityAction;
  entityType: ActivityEntity;
  entityId: string;
  /** The sentence, written now. */
  summary: string;
  /** Anything a reader might want that is not in the sentence. */
  metadata?: Record<string, unknown>;
};

/**
 * Writes one event.
 *
 * Deliberately not awaited by most callers — and safe either way, because it
 * cannot throw. An activity row is a nice-to-have beside the invoice it
 * describes.
 */
export async function record(input: ActivityInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        summary: input.summary,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    });
  } catch {
    // Nothing here is worth failing a business action over.
  }
}

// ------------------------------------------------------ what gets recorded ---

/**
 * Notes and files hang off the same kinds of record, which their own modules
 * name in lower case. Five of those have a timeline. An expense has none, so
 * a note or a receipt on one is not news anywhere.
 */
const TIMELINE_FOR: Record<string, ActivityEntity> = {
  client: "CLIENT",
  lead: "LEAD",
  job: "JOB",
  estimate: "ESTIMATE",
  invoice: "INVOICE",
};

/** The timeline a note or an upload on this kind of record belongs on. */
export function timelineFor(recordKind: string): ActivityEntity | null {
  return TIMELINE_FOR[recordKind] ?? null;
}

/**
 * The start of a note, as its timeline line quotes it.
 *
 * Long enough to tell which note it was, short enough that the timeline stays
 * a list of what happened rather than a second copy of the notes. Cut at a
 * word when there is one close to the limit.
 */
export function noteExcerpt(body: string, max = 80): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;

  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The line for one batch of uploads.
 *
 * One line per batch, not per file: ten photos from one visit are one thing
 * that happened. Counted and captioned rather than named, because a phone
 * calls its photos IMG_4032.jpg and the caption is what a person wrote. A
 * "document" upload says "file", since an image sent that way is filed as a
 * photo.
 */
export function uploadSummary(
  count: number,
  kind: string,
  caption?: string | null,
): string {
  const noun = kind === "PHOTO" ? "photo" : kind === "CONTRACT" ? "contract" : "file";
  const what = count === 1 ? `a ${noun}` : `${count} ${noun}s`;
  const said = caption?.trim();
  return `Added ${what}${said ? ` — ${said}` : ""}`;
}

/**
 * Takes a deleted note's line off the timeline.
 *
 * The one place the timeline is allowed to change behind you, and on purpose.
 * Its line quotes the note, and a note deleted because it should never have
 * been written must not live on as a quotation of itself.
 */
export async function forgetNote(organizationId: string, noteId: string): Promise<void> {
  try {
    await prisma.auditLog.deleteMany({
      where: {
        organizationId,
        action: "note.added",
        metadata: { contains: `"noteId":"${noteId}"` },
      },
    });
  } catch {
    // As with record(): the note is gone, which is what was asked for.
  }
}

export type ActivityEvent = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string | null;
  createdAt: Date;
  actor: string | null;
};

/** Where an event points, so a line on the timeline can be followed. */
export function activityHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case "CLIENT":
      return `/clients/${entityId}`;
    case "LEAD":
      return `/leads/${entityId}`;
    case "JOB":
      return `/jobs/${entityId}`;
    case "ESTIMATE":
      return `/estimates/${entityId}`;
    case "INVOICE":
      return `/invoices/${entityId}`;
    default:
      // A payment has no page of its own; it is read on its invoice.
      return null;
  }
}

export function activityMeta(action: string) {
  return (
    ACTIVITY_META[action as ActivityAction] ?? {
      icon: "note" as ActivityIcon,
      tone: "neutral" as ActivityTone,
    }
  );
}

/**
 * Whether somebody may see the business's activity at all.
 *
 * The timeline is written in plain sentences, and plain sentences carry what
 * the underlying screens are careful to hide: "$1,250 received against invoice
 * INV-1042" is a payment amount, and "Job created — Kitchen remodel" names work
 * that a technician is not assigned and cannot otherwise see. So the feed is
 * for people who can see the whole business and its money — owners, admins
 * and managers — and not for a technician, whose own screens are narrowed to
 * their own work.
 *
 * This shipped first without the check, on the client page, where any
 * employee could read a client's payment history as timeline lines.
 */
export function canSeeBusinessActivity(actor: Actor): boolean {
  return can(actor, "jobs:read:all") && can(actor, "invoices:read");
}

/**
 * The events a given person may not see, by the permission that guards the
 * screen each event describes.
 *
 * Defence in depth behind canSeeBusinessActivity(): a caller that forgets the
 * gate still cannot hand a payment line to somebody without payments:read.
 */
export function hiddenActions(actor: Actor): ActivityAction[] {
  const hidden: ActivityAction[] = [];

  if (!can(actor, "estimates:read")) {
    hidden.push(
      "estimate.sent",
      "estimate.accepted",
      "estimate.declined",
      "estimate.converted",
    );
  }
  if (!can(actor, "invoices:read")) {
    hidden.push("invoice.sent", "invoice.cancelled");
  }
  if (!can(actor, "payments:read")) {
    hidden.push("payment.recorded");
  }

  return hidden;
}

/**
 * Whole kinds of record a person may not see events about.
 *
 * hiddenActions() hides the events that are about money by name. A note or an
 * upload is neither — but a note on an invoice is the invoice's business, so
 * whatever is filed against a record is hidden along with it.
 */
export function hiddenEntities(actor: Actor): ActivityEntity[] {
  const hidden: ActivityEntity[] = [];

  if (!can(actor, "estimates:read")) hidden.push("ESTIMATE");
  if (!can(actor, "invoices:read")) hidden.push("INVOICE");
  if (!can(actor, "payments:read")) hidden.push("PAYMENT");
  if (!can(actor, "leads:read")) hidden.push("LEAD");

  return hidden;
}

/** Both filters, as the part of a query that applies them. */
function visibleTo(viewer: Actor) {
  const actions = hiddenActions(viewer);
  const entities = hiddenEntities(viewer);

  return {
    ...(actions.length ? { action: { notIn: actions } } : {}),
    ...(entities.length ? { entityType: { notIn: entities } } : {}),
  };
}

type EntityRef = { entityType: ActivityEntity; entityId: string };

async function eventsFor(
  organizationId: string,
  refs: EntityRef[],
  limit: number,
  viewer: Actor,
): Promise<ActivityEvent[]> {
  if (refs.length === 0) return [];

  const rows = await prisma.auditLog.findMany({
    where: {
      organizationId,
      OR: refs.map((ref) => ({
        entityType: ref.entityType,
        entityId: ref.entityId,
      })),
      ...visibleTo(viewer),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      summary: true,
      createdAt: true,
      user: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    summary: row.summary,
    createdAt: row.createdAt,
    actor: row.user?.name ?? null,
  }));
}

/**
 * Everything that has happened to one client, including on their work.
 *
 * A client's story is not only the events filed against the client row: it is
 * the jobs, the estimates and the invoices too, which is the whole reason
 * somebody opens this tab. Their ids are collected first and the events are
 * fetched in one query against the (entityType, entityId) index.
 *
 * The alternative would be a clientId column on every event, which is a
 * migration and a second source of truth about which client something belongs
 * to. For a small business's volumes this is cheaper than both.
 */
export async function clientTimeline(
  organizationId: string,
  clientId: string,
  viewer: Actor,
  limit = 50,
): Promise<ActivityEvent[]> {
  const [jobs, estimates, invoices] = await Promise.all([
    prisma.job.findMany({
      where: { organizationId, clientId },
      select: { id: true },
    }),
    prisma.estimate.findMany({
      where: { organizationId, clientId },
      select: { id: true },
    }),
    prisma.invoice.findMany({
      where: { organizationId, clientId },
      select: { id: true },
    }),
  ]);

  const refs: EntityRef[] = [
    { entityType: "CLIENT", entityId: clientId },
    ...jobs.map((job) => ({ entityType: "JOB" as const, entityId: job.id })),
    ...estimates.map((e) => ({ entityType: "ESTIMATE" as const, entityId: e.id })),
    ...invoices.map((i) => ({ entityType: "INVOICE" as const, entityId: i.id })),
  ];

  return eventsFor(organizationId, refs, limit, viewer);
}

/**
 * Everything that has happened to one job.
 *
 * For somebody who may see the business's money, that includes the estimate
 * the job was won from and the invoices raised against it: a job's story does
 * not stop at its own row, any more than a client's does. For the crew it is
 * the job itself — what was booked, what changed, what was noted, photographed
 * and finished — which is everything the job page already shows them.
 */
export async function jobTimeline(
  organizationId: string,
  jobId: string,
  viewer: Actor,
  limit = 30,
): Promise<ActivityEvent[]> {
  const refs: EntityRef[] = [{ entityType: "JOB", entityId: jobId }];

  if (canSeeBusinessActivity(viewer)) {
    const [estimates, invoices] = await Promise.all([
      prisma.estimate.findMany({
        where: { organizationId, convertedJobId: jobId },
        select: { id: true },
      }),
      prisma.invoice.findMany({
        where: { organizationId, jobId },
        select: { id: true },
      }),
    ]);

    refs.push(
      ...estimates.map((e) => ({ entityType: "ESTIMATE" as const, entityId: e.id })),
      ...invoices.map((i) => ({ entityType: "INVOICE" as const, entityId: i.id })),
    );
  }

  return eventsFor(organizationId, refs, limit, viewer);
}

/** The whole workspace, newest first — what the business did this week. */
export async function recentActivity(
  organizationId: string,
  viewer: Actor,
  limit = 20,
): Promise<ActivityEvent[]> {
  const rows = await prisma.auditLog.findMany({
    where: {
      organizationId,
      ...visibleTo(viewer),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      summary: true,
      createdAt: true,
      user: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    summary: row.summary,
    createdAt: row.createdAt,
    actor: row.user?.name ?? null,
  }));
}

/**
 * Groups events under the day they happened, newest day first.
 *
 * Pure, so the grouping is testable without a database, and done on the server
 * so the client component renders a list rather than working out dates.
 */
export function groupByDay(
  events: ActivityEvent[],
  now = new Date(),
): { label: string; events: ActivityEvent[] }[] {
  const groups = new Map<string, ActivityEvent[]>();

  for (const event of events) {
    const key = dayKey(event.createdAt);
    const bucket = groups.get(key);
    if (bucket) bucket.push(event);
    else groups.set(key, [event]);
  }

  return [...groups.entries()].map(([key, grouped]) => ({
    label: dayLabel(key, now),
    events: grouped,
  }));
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(key: string, now: Date) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month, day);

  if (dayKey(now) === key) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(yesterday) === key) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    // A year only once it is not this one — "Mar 4" reads better than
    // "Mar 4, 2026" on everything that happened this year.
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

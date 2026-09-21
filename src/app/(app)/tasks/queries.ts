import { prisma } from "@/lib/db";
import { taskVisibilityWhere, type Actor } from "@/lib/permissions";

/**
 * Reads for the task list.
 *
 * Every query goes through `taskVisibilityWhere`, so a technician's list is
 * their own work and what they handed on, while anyone who can see the whole
 * business sees the shared pile too.
 */

const PAGE_SIZE = 50;

export const TASK_VIEWS = ["open", "overdue", "today", "done"] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export function asTaskView(value: string | undefined): TaskView {
  return TASK_VIEWS.includes(value as TaskView) ? (value as TaskView) : "open";
}

/** Midnight tonight, in the server's zone — the boundary "today" ends on. */
function endOfToday(now = new Date()) {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

function viewWhere(view: TaskView, now: Date) {
  switch (view) {
    case "done":
      return { status: "DONE" };
    case "overdue":
      // Anything still open whose date has passed. A task with no date can
      // never be overdue — it was never promised for a day.
      return { status: "OPEN", dueAt: { lt: now } };
    case "today":
      return { status: "OPEN", dueAt: { lte: endOfToday(now) } };
    default:
      return { status: "OPEN" };
  }
}

type TaskQuery = {
  organizationId: string;
  actor: Actor;
  view: TaskView;
  /** Narrow to one person, "me", or leave open for everyone. */
  assignee?: string;
  q?: string;
  page?: number;
};

function where(query: TaskQuery, now: Date) {
  const search = query.q?.trim();
  const assignee =
    query.assignee === "me" ? (query.actor.id ?? "") : query.assignee;

  return {
    organizationId: query.organizationId,
    ...taskVisibilityWhere(query.actor),
    ...viewWhere(query.view, now),
    ...(assignee
      ? assignee === "unassigned"
        ? { assignedToId: null }
        : { assignedToId: assignee }
      : {}),
    ...(search ? { title: { contains: search } } : {}),
  };
}

const TASK_SELECT = {
  id: true,
  title: true,
  notes: true,
  status: true,
  dueAt: true,
  completedAt: true,
  createdAt: true,
  assignedTo: { select: { id: true, name: true } },
  client: { select: { id: true, displayName: true } },
  job: { select: { id: true, number: true, title: true } },
  lead: { select: { id: true, name: true } },
} as const;

export type TaskRow = Awaited<ReturnType<typeof listTasks>>["rows"][number];

export async function listTasks(query: TaskQuery) {
  const now = new Date();
  const page = Math.max(1, query.page ?? 1);
  const filter = where(query, now);

  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where: filter,
      // Dated work first and soonest first; undated drifts to the bottom
      // rather than the top, where it would bury what was promised.
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: TASK_SELECT,
    }),
    prisma.task.count({ where: filter }),
  ]);

  return {
    rows,
    total,
    page,
    pageSize: PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

/** The counts on the tabs, so each says how much is behind it. */
export async function taskCounts(organizationId: string, actor: Actor) {
  const now = new Date();
  const scope = { organizationId, ...taskVisibilityWhere(actor) };

  const [open, overdue, today, done] = await Promise.all([
    prisma.task.count({ where: { ...scope, status: "OPEN" } }),
    prisma.task.count({ where: { ...scope, status: "OPEN", dueAt: { lt: now } } }),
    prisma.task.count({
      where: { ...scope, status: "OPEN", dueAt: { lte: endOfToday(now) } },
    }),
    prisma.task.count({ where: { ...scope, status: "DONE" } }),
  ]);

  return { open, overdue, today, done };
}

/** The open tasks hanging off one job or client, for its own page. */
export async function tasksFor(
  organizationId: string,
  actor: Actor,
  link: { jobId?: string; clientId?: string; leadId?: string },
) {
  return prisma.task.findMany({
    where: {
      organizationId,
      ...taskVisibilityWhere(actor),
      ...(link.jobId ? { jobId: link.jobId } : {}),
      ...(link.clientId ? { clientId: link.clientId } : {}),
      ...(link.leadId ? { leadId: link.leadId } : {}),
    },
    orderBy: [
      // Open before done, then by date: a panel is for what is left.
      //
      // Descending, because the statuses are words and "DONE" sorts before
      // "OPEN" — ascending put every finished task at the top of the panel.
      { status: "desc" },
      { dueAt: { sort: "asc", nulls: "last" } },
    ],
    take: 25,
    select: TASK_SELECT,
  });
}

/**
 * What the dashboard tile reads: how much is due, and how much is late.
 *
 * Scoped to the person looking, so a technician's tile counts their own list
 * rather than the whole company's.
 */
export async function taskSummary(organizationId: string, actor: Actor) {
  const now = new Date();
  const scope = {
    organizationId,
    ...taskVisibilityWhere(actor),
    status: "OPEN",
  };

  const [dueToday, overdue] = await Promise.all([
    prisma.task.count({ where: { ...scope, dueAt: { lte: endOfToday(now) } } }),
    prisma.task.count({ where: { ...scope, dueAt: { lt: now } } }),
  ]);

  return { dueToday, overdue };
}

import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  asTaskView,
  listTasks,
  taskCounts,
  taskSummary,
  tasksFor,
} from "@/app/(app)/tasks/queries";
import { prisma } from "@/lib/db";
import { can, taskVisibilityWhere } from "@/lib/permissions";

/**
 * Tasks.
 *
 * The two things that carry the feature are what each person is allowed to
 * see — a technician's list is theirs, not the company's — and what "overdue"
 * and "due today" actually mean, since the tile and the tabs both count on it.
 */

let organizationId: string;
let otherOrganizationId: string;
let owner: { id: string; role: "OWNER" };
let tech: { id: string; role: "EMPLOYEE" };
let clientId: string;
let jobId: string;

const hoursFromNow = (hours: number) =>
  new Date(Date.now() + hours * 60 * 60 * 1000);

async function seedOrg(name: string) {
  const org = await prisma.organization.create({
    data: { slug: `tasks-${randomUUID()}`, name },
  });
  return org.id;
}

async function addUser(orgId: string, role: string, name: string) {
  const user = await prisma.user.create({
    data: {
      organizationId: orgId,
      email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
      name,
      passwordHash: "x",
      role,
    },
  });
  return user.id;
}

async function addTask(data: {
  title: string;
  status?: string;
  dueAt?: Date | null;
  assignedToId?: string | null;
  createdById?: string | null;
  jobId?: string | null;
  clientId?: string | null;
  organizationId?: string;
}) {
  return prisma.task.create({
    data: {
      organizationId: data.organizationId ?? organizationId,
      title: data.title,
      status: data.status ?? "OPEN",
      dueAt: data.dueAt ?? null,
      assignedToId: data.assignedToId ?? null,
      createdById: data.createdById ?? null,
      jobId: data.jobId ?? null,
      clientId: data.clientId ?? null,
    },
  });
}

beforeEach(async () => {
  organizationId = await seedOrg("Task Test Co");
  otherOrganizationId = await seedOrg("Someone Else Ltd");

  owner = { id: await addUser(organizationId, "OWNER", "Alex Rivera"), role: "OWNER" };
  tech = {
    id: await addUser(organizationId, "EMPLOYEE", "Priya Raghavan"),
    role: "EMPLOYEE",
  };

  const client = await prisma.client.create({
    data: { organizationId, displayName: "Oscar Nakamura", type: "PERSON" },
  });
  clientId = client.id;

  const job = await prisma.job.create({
    data: { organizationId, clientId, number: "JOB-1", title: "Panel upgrade" },
  });
  jobId = job.id;
});

describe("who sees what", () => {
  it("shows an employee their own work and what they handed on", async () => {
    await addTask({ title: "Assigned to the tech", assignedToId: tech.id });
    await addTask({ title: "Raised by the tech", createdById: tech.id });
    await addTask({ title: "Somebody else's", assignedToId: owner.id });
    await addTask({ title: "Nobody's" });

    const list = await listTasks({ organizationId, actor: tech, view: "open" });

    // A task you wrote and handed to somebody else is still yours to chase,
    // which is why created-by counts as well as assigned-to.
    expect(list.rows.map((row) => row.title).sort()).toEqual([
      "Assigned to the tech",
      "Raised by the tech",
    ]);
  });

  it("shows an owner the whole list, unassigned included", async () => {
    await addTask({ title: "Assigned to the tech", assignedToId: tech.id });
    await addTask({ title: "Nobody's" });

    const list = await listTasks({ organizationId, actor: owner, view: "open" });

    expect(list.total).toBe(2);
  });

  it("never reaches another business's tasks", async () => {
    await addTask({
      title: "Theirs",
      organizationId: otherOrganizationId,
    });

    const list = await listTasks({ organizationId, actor: owner, view: "open" });
    expect(list.total).toBe(0);
  });

  it("gives an employee the permission to tick things off", async () => {
    // A technician with a list they cannot close would be worse than no list.
    expect(can(tech, "tasks:read")).toBe(true);
    expect(can(tech, "tasks:write")).toBe(true);
    // But not the whole company's.
    expect(can(tech, "tasks:read:all")).toBe(false);
    expect(can(owner, "tasks:read:all")).toBe(true);
  });

  it("narrows the query for anyone without the wider permission", () => {
    expect(taskVisibilityWhere(owner)).toEqual({});
    expect(taskVisibilityWhere(tech)).toEqual({
      OR: [{ assignedToId: tech.id }, { createdById: tech.id }],
    });
  });
});

describe("the views", () => {
  beforeEach(async () => {
    await addTask({ title: "Late", dueAt: hoursFromNow(-48) });
    await addTask({ title: "Later today", dueAt: hoursFromNow(2) });
    await addTask({ title: "Next week", dueAt: hoursFromNow(24 * 7) });
    await addTask({ title: "Someday", dueAt: null });
    await addTask({ title: "Finished", status: "DONE", dueAt: hoursFromNow(-72) });
  });

  it("counts overdue as open work whose date has passed", async () => {
    const list = await listTasks({ organizationId, actor: owner, view: "overdue" });

    // Not the finished one, however late it was.
    expect(list.rows.map((r) => r.title)).toEqual(["Late"]);
  });

  it("treats a dateless task as never overdue", async () => {
    // It was never promised for a day, so it cannot be late.
    const overdue = await listTasks({ organizationId, actor: owner, view: "overdue" });
    expect(overdue.rows.some((r) => r.title === "Someday")).toBe(false);
  });

  it("counts anything due by tonight as due today", async () => {
    const list = await listTasks({ organizationId, actor: owner, view: "today" });

    // Includes what is already late: it is still outstanding today.
    expect(list.rows.map((r) => r.title).sort()).toEqual(["Late", "Later today"]);
  });

  it("puts dated work first and undated at the bottom", async () => {
    const list = await listTasks({ organizationId, actor: owner, view: "open" });

    expect(list.rows[0].title).toBe("Late");
    expect(list.rows[list.rows.length - 1].title).toBe("Someday");
  });

  it("counts each tab", async () => {
    const counts = await taskCounts(organizationId, owner);

    expect(counts).toEqual({ open: 4, overdue: 1, today: 2, done: 1 });
  });
});

describe("taskSummary", () => {
  it("is what the dashboard tile reads, scoped to the person", async () => {
    await addTask({ title: "Mine, late", dueAt: hoursFromNow(-3), assignedToId: tech.id });
    await addTask({ title: "Theirs, late", dueAt: hoursFromNow(-3), assignedToId: owner.id });

    const mine = await taskSummary(organizationId, tech);
    const everyones = await taskSummary(organizationId, owner);

    // A technician's tile counts their own list, not the company's.
    expect(mine).toEqual({ dueToday: 1, overdue: 1 });
    expect(everyones).toEqual({ dueToday: 2, overdue: 2 });
  });

  it("says nothing is due when nothing has a date", async () => {
    await addTask({ title: "Someday", dueAt: null });

    expect(await taskSummary(organizationId, owner)).toEqual({
      dueToday: 0,
      overdue: 0,
    });
  });
});

describe("tasksFor", () => {
  it("gathers the tasks on one job", async () => {
    await addTask({ title: "On the job", jobId });
    await addTask({ title: "Elsewhere" });

    const tasks = await tasksFor(organizationId, owner, { jobId });
    expect(tasks.map((t) => t.title)).toEqual(["On the job"]);
  });

  it("puts what is left before what is finished", async () => {
    await addTask({ title: "Done already", jobId, status: "DONE" });
    await addTask({ title: "Still to do", jobId, dueAt: hoursFromNow(5) });

    const tasks = await tasksFor(organizationId, owner, { jobId });
    expect(tasks.map((t) => t.title)).toEqual(["Still to do", "Done already"]);
  });

  it("goes when its job goes", async () => {
    await addTask({ title: "On the job", jobId });

    await prisma.job.delete({ where: { id: jobId } });

    // A task about a deleted job is a question nobody can answer.
    const left = await prisma.task.count({ where: { organizationId } });
    expect(left).toBe(0);
  });
});

describe("asTaskView", () => {
  it("defaults to what is open, and rejects anything unexpected", () => {
    expect(asTaskView(undefined)).toBe("open");
    expect(asTaskView("nonsense")).toBe("open");
    expect(asTaskView("overdue")).toBe("overdue");
    expect(asTaskView("done")).toBe("done");
  });
});

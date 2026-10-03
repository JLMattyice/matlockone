import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Job checklists.
 *
 * What is pinned: a pasted list reads as the items it plainly is; a saved
 * list lands on new jobs of its category by itself — each visit of a
 * repeating job getting its own copy — and on others only when picked; a job
 * keeps its copy when the saved list changes; the crew can tick the jobs they
 * are on and nothing else, and cannot change what is on the list; and an open
 * item never stops a job being completed (the owner's "track only").
 */

const session = vi.hoisted(() => ({
  user: null as unknown as Record<string, unknown>,
  org: null as unknown as Record<string, unknown>,
}));

vi.mock("@/lib/auth", async () => {
  const { assertCan } = await import("@/lib/permissions");
  return {
    requireContext: async () => session,
    requirePermission: async (permission: string) => {
      assertCan(session.user as never, permission as never);
      return session;
    },
    getContext: async () => session,
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/viewer-time-zone", () => ({ viewerTimeZone: async () => "UTC" }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import {
  addChecklistItems,
  applyChecklistTemplate,
  removeChecklistItem,
  setChecklistItemDone,
} from "@/app/(app)/jobs/checklist-actions";
import { createJob, setJobStatus, updateJob } from "@/app/(app)/jobs/actions";
import { deleteJobCategory } from "@/app/(app)/settings/calendar/actions";
import { saveChecklistTemplate } from "@/app/(app)/settings/checklists/actions";
import { IDLE } from "@/lib/action-state";
import { parseChecklistLines, readChecklistItems } from "@/lib/checklists";
import { prisma } from "@/lib/db";

const orgs: string[] = [];
let organizationId: string;
let ownerId: string;

function form(fields: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of [value].flat()) data.append(key, one);
  }
  return data;
}

async function signInAs(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  session.user = user as unknown as Record<string, unknown>;
  session.org = (await prisma.organization.findUniqueOrThrow({
    where: { id: user.organizationId },
  })) as unknown as Record<string, unknown>;
}

async function person(role: "OWNER" | "EMPLOYEE", name: string) {
  const user = await prisma.user.create({
    data: { organizationId, email: `${randomUUID()}@test.local`, name, passwordHash: "x", role },
  });
  return user.id;
}

beforeEach(async () => {
  const org = await prisma.organization.create({
    data: { slug: `lists-${randomUUID()}`, name: "Checklist Test Co" },
  });
  orgs.push(org.id);
  organizationId = org.id;
  ownerId = await person("OWNER", "Owner");
  await signInAs(ownerId);
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

const saveList = (fields: Record<string, string>) => saveChecklistTemplate(IDLE, form(fields));

/** Books an entry through the real action and returns it. */
async function book(title: string, extra: Record<string, string | string[]> = {}) {
  await createJob(
    IDLE,
    form({ title, category: "JOB", status: "SCHEDULED", priority: "NORMAL", durationMinutes: "60", ...extra }),
  ).catch((error: Error) => {
    if (!error.message.startsWith("NEXT_REDIRECT")) throw error;
  });
  return prisma.job.findFirstOrThrow({ where: { organizationId, title }, orderBy: { createdAt: "asc" } });
}

const labels = async (jobId: string) =>
  (
    await prisma.jobChecklistItem.findMany({
      where: { jobId },
      orderBy: { sortOrder: "asc" },
      select: { label: true },
    })
  ).map((item) => item.label);

describe("reading a typed or pasted list", () => {
  it("keeps the items, drops bullets, numbers, blanks and repeats", () => {
    expect(
      parseChecklistLines(
        "- Before photos\n* Work done\n\n• Clean up\n1. Walk-through\n2) Invoice left\n[ ] Gate shut\n[x] Dog in\n  before photos  \nA - B stays whole",
      ),
    ).toEqual(["Before photos", "Work done", "Clean up", "Walk-through", "Invoice left", "Gate shut", "Dog in", "A - B stays whole"]);
  });

  it("reads back nothing rather than failing on a damaged column", () => {
    expect(readChecklistItems("not json")).toEqual([]);
    expect(readChecklistItems('{"a":1}')).toEqual([]);
    expect(readChecklistItems('["One", 2, "", "Three"]')).toEqual(["One", "Three"]);
  });
});

describe("saved checklists", () => {
  it("are saved with their items, and refuse an empty list or a second of the same name", async () => {
    expect(await saveList({ name: "Wrap-up", items: "Photos\nClean up", appliesTo: "" })).toMatchObject({ ok: true });
    expect(await saveList({ name: "wrap-up", items: "Other", appliesTo: "" })).toEqual({
      ok: false,
      fieldErrors: { name: "You already have Wrap-up." },
    });
    expect(await saveList({ name: "Empty", items: "\n - \n", appliesTo: "" })).toMatchObject({
      ok: false,
      fieldErrors: { items: expect.stringMatching(/at least one item/) },
    });
    const [row] = await prisma.checklistTemplate.findMany({ where: { organizationId } });
    expect(row).toMatchObject({ name: "Wrap-up", kind: null, categoryId: null });
    expect(readChecklistItems(row.items)).toEqual(["Photos", "Clean up"]);
  });

  it("cannot be pointed at another business's category", async () => {
    const other = await prisma.organization.create({ data: { slug: `other-${randomUUID()}`, name: "Other" } });
    orgs.push(other.id);
    const theirs = await prisma.jobCategory.create({
      data: { organizationId: other.id, name: "Theirs", icon: "tag", kind: "JOB" },
    });
    expect(await saveList({ name: "Sneaky", items: "One", appliesTo: `category:${theirs.id}` })).toMatchObject({
      ok: false,
      fieldErrors: { appliesTo: expect.any(String) },
    });
  });

  it("are the owner's to change, not the crew's", async () => {
    await signInAs(await person("EMPLOYEE", "Sam"));
    await expect(saveList({ name: "Mine", items: "One", appliesTo: "" })).rejects.toThrow(/settings:write/);
  });
});

describe("putting a checklist on a job", () => {
  it("goes on every new job of its category by itself, and each visit of a repeating job gets its own", async () => {
    await saveList({ name: "Wrap-up", items: "Before photos\nAfter photos", appliesTo: "JOB" });
    await saveList({ name: "Safety", items: "Ladder check\nafter photos", appliesTo: "JOB" });
    await saveList({ name: "Meetings only", items: "Agenda", appliesTo: "MEETING" });
    await saveList({ name: "By hand", items: "Never automatic", appliesTo: "" });

    const job = await book("Gutters");
    // Both lists, in name order; the repeated line is asked for once.
    expect(await labels(job.id)).toEqual(["Ladder check", "after photos", "Before photos"]);

    await book("Weekly lawn", {
      scheduledStart: "2026-11-02T09:00",
      repeat: "on",
      frequency: "WEEKLY",
      interval: "1",
      occurrences: "3",
    });
    const visits = await prisma.job.findMany({ where: { organizationId, title: "Weekly lawn" }, select: { id: true } });
    expect(visits).toHaveLength(3);
    for (const visit of visits) expect(await labels(visit.id)).toHaveLength(3);
    const ids = await prisma.jobChecklistItem.findMany({ where: { jobId: { in: visits.map((v) => v.id) } } });
    expect(new Set(ids.map((item) => item.id)).size).toBe(9);
  });

  it("goes on a job of a business's own category, and stops when the category is deleted", async () => {
    const install = await prisma.jobCategory.create({
      data: { organizationId, name: "Install", icon: "wrench", kind: "JOB" },
    });
    await saveList({ name: "Install list", items: "Permit posted", appliesTo: `category:${install.id}` });

    const plain = await book("Plain job");
    expect(await labels(plain.id)).toEqual([]);
    const installed = await book("New unit", { category: `category:${install.id}` });
    expect(await labels(installed.id)).toEqual(["Permit posted"]);

    await deleteJobCategory(form({ id: install.id }));
    expect(await prisma.checklistTemplate.findFirst({ where: { organizationId } })).toMatchObject({ categoryId: null });
  });

  it("is added when a job without one moves into the category, but never doubled", async () => {
    await saveList({ name: "Meeting notes", items: "Agenda sent", appliesTo: "MEETING" });
    const job = await book("Catch-up", { category: "APPOINTMENT" });
    const edit = (category: string) =>
      updateJob(IDLE, form({ id: job.id, title: "Catch-up", category, status: "SCHEDULED", priority: "NORMAL", durationMinutes: "60" }));

    await edit("MEETING");
    expect(await labels(job.id)).toEqual(["Agenda sent"]);
    await edit("APPOINTMENT");
    await edit("MEETING");
    expect(await labels(job.id)).toEqual(["Agenda sent"]);
  });

  it("is a copy: changing the saved list later leaves a job's items alone", async () => {
    await saveList({ name: "Wrap-up", items: "Photos", appliesTo: "JOB" });
    const job = await book("Fence");
    const template = await prisma.checklistTemplate.findFirstOrThrow({ where: { organizationId } });
    await saveList({ id: template.id, name: "Wrap-up", items: "Something new", appliesTo: "JOB" });
    expect(await labels(job.id)).toEqual(["Photos"]);
  });

  it("can be picked from the job page, adding only what is not there yet", async () => {
    const job = await book("Deck");
    await saveList({ name: "Deck", items: "Boards\nRailings", appliesTo: "" });
    const template = await prisma.checklistTemplate.findFirstOrThrow({ where: { organizationId } });

    expect(await addChecklistItems(IDLE, form({ jobId: job.id, items: "Railings" }))).toMatchObject({ ok: true });
    expect(await applyChecklistTemplate(IDLE, form({ jobId: job.id, templateId: template.id }))).toEqual({
      ok: true,
      message: "Added Deck.",
    });
    expect(await labels(job.id)).toEqual(["Railings", "Boards"]);
    expect(await applyChecklistTemplate(IDLE, form({ jobId: job.id, templateId: template.id }))).toEqual({
      ok: true,
      message: "Everything on Deck is already here.",
    });
  });
});

describe("ticking it off", () => {
  it("lets the crew tick the jobs they are on — and nothing else, nor change the list", async () => {
    const sam = await person("EMPLOYEE", "Sam");
    await saveList({ name: "Wrap-up", items: "Photos\nClean up", appliesTo: "JOB" });
    const theirs = await book("Sam's job", { assigneeIds: [sam] });
    const notTheirs = await book("Someone else's job");
    const [photos] = await prisma.jobChecklistItem.findMany({ where: { jobId: theirs.id }, orderBy: { sortOrder: "asc" } });
    const [other] = await prisma.jobChecklistItem.findMany({ where: { jobId: notTheirs.id } });

    await signInAs(sam);
    expect(await setChecklistItemDone(photos.id, true)).toEqual({ ok: true });
    expect(await setChecklistItemDone(other.id, true)).toEqual({ ok: false });
    await expect(removeChecklistItem(photos.id)).rejects.toThrow(/jobs:write/);
    await expect(addChecklistItems(IDLE, form({ jobId: theirs.id, items: "Mine" }))).rejects.toThrow(/jobs:write/);

    expect(await prisma.jobChecklistItem.findUniqueOrThrow({ where: { id: photos.id } })).toMatchObject({ doneById: sam });
    expect((await prisma.jobChecklistItem.findUniqueOrThrow({ where: { id: other.id } })).doneAt).toBeNull();
  });

  it("keeps who ticked it first, and clears when unticked", async () => {
    await saveList({ name: "Wrap-up", items: "Photos", appliesTo: "JOB" });
    const job = await book("Roof");
    const [item] = await prisma.jobChecklistItem.findMany({ where: { jobId: job.id } });

    await setChecklistItemDone(item.id, true);
    const first = await prisma.jobChecklistItem.findUniqueOrThrow({ where: { id: item.id } });
    await setChecklistItemDone(item.id, true);
    expect((await prisma.jobChecklistItem.findUniqueOrThrow({ where: { id: item.id } })).doneAt).toEqual(first.doneAt);

    await setChecklistItemDone(item.id, false);
    expect(await prisma.jobChecklistItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ doneAt: null, doneById: null });
  });

  it("never stops a job being completed", async () => {
    await saveList({ name: "Wrap-up", items: "Photos\nClean up", appliesTo: "JOB" });
    const job = await book("Siding");
    await setJobStatus(form({ id: job.id, status: "IN_PROGRESS" }));
    await setJobStatus(form({ id: job.id, status: "COMPLETED" }));
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "COMPLETED" });
  });
});

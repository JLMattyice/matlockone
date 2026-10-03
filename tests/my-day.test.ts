import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * My Day, the day clock and the job timer.
 *
 * What is pinned: the clock opens once and closes once, and a forgotten
 * clock-out can be closed at the time they really stopped, never in the
 * future; a timer runs on one job at a time, clocks you in, stops when you
 * clock out, and cannot count a weekend; the crew start and finish their own
 * visits — not anybody else's — and an open checklist never stops them; the
 * day screen shows their visits and nobody else's; a manager can correct the
 * clock and the crew cannot; and the crew land on My Day, not the dashboard.
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

import { clockInNow, clockOutNow, completeVisit, startVisit, stopVisitTimer } from "@/app/(app)/my-day/actions";
import { myDay } from "@/app/(app)/my-day/queries";
import { fixClockEntry } from "@/app/(app)/team/time-clock/actions";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import { NAVIGATION } from "@/lib/navigation";
import { can } from "@/lib/permissions";
import { startTimer, stopTimer, TIMER_MAX_MINUTES } from "@/lib/time-clock";

const HOUR = 60 * 60 * 1000;
const orgs: string[] = [];
let organizationId: string;
let crewId: string;
let managerId: string;

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function person(name: string, role: string, hourlyRateCents: number | null = null) {
  const user = await prisma.user.create({
    data: { organizationId, email: `${randomUUID()}@test.local`, name, passwordHash: "x", role, hourlyRateCents },
  });
  return user.id;
}

async function signInAs(userId: string) {
  session.user = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })) as unknown as Record<string, unknown>;
  session.org = (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })) as unknown as Record<
    string,
    unknown
  >;
}

let numbers = 0;
async function visit(title: string, extra: { assign?: string[]; start?: Date | null; status?: string } = {}) {
  return prisma.job.create({
    data: {
      organizationId,
      number: `J-${++numbers}`,
      title,
      status: extra.status ?? "SCHEDULED",
      scheduledStart: extra.start === undefined ? new Date() : extra.start,
      assignments: { create: (extra.assign ?? [crewId]).map((userId) => ({ userId })) },
    },
  });
}

const statusOf = async (jobId: string) => (await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status;
const openTimers = () => prisma.timeEntry.findMany({ where: { organizationId, endedAt: null } });
const openClocks = () => prisma.clockEntry.findMany({ where: { organizationId, clockedOutAt: null } });

beforeEach(async () => {
  const org = await prisma.organization.create({ data: { slug: `day-${randomUUID()}`, name: "Day Test Co", timeZone: "UTC" } });
  orgs.push(org.id);
  organizationId = org.id;
  crewId = await person("Sam Crew", "EMPLOYEE", 3000);
  managerId = await person("Max Manager", "MANAGER");
  await signInAs(crewId);
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

describe("the day clock", () => {
  it("opens once however often it is tapped, and closes once", async () => {
    await clockInNow(IDLE);
    await clockInNow(IDLE);
    expect(await openClocks()).toHaveLength(1);

    expect(await clockOutNow(IDLE, form({}))).toMatchObject({ ok: true, message: "Clocked out." });
    expect(await openClocks()).toHaveLength(0);
    expect(await clockOutNow(IDLE, form({}))).toMatchObject({ message: "You were not clocked in." });
  });

  it("closes a forgotten one at the time they really stopped — never later than now, never before it began", async () => {
    const yesterday = new Date(Date.now() - 26 * HOUR);
    await prisma.clockEntry.create({ data: { organizationId, userId: crewId, clockedInAt: yesterday } });
    const local = (date: Date) => date.toISOString().slice(0, 16);

    expect(await clockOutNow(IDLE, form({ at: local(new Date(Date.now() + 2 * HOUR)) }))).toMatchObject({
      fieldErrors: { at: "That is still to come." },
    });
    expect(await clockOutNow(IDLE, form({ at: local(new Date(yesterday.getTime() - HOUR)) }))).toMatchObject({
      fieldErrors: { at: "That is before you clocked in." },
    });
    await clockOutNow(IDLE, form({ at: local(new Date(yesterday.getTime() + 8 * HOUR)) }));

    const [entry] = await prisma.clockEntry.findMany({ where: { organizationId } });
    expect((entry.clockedOutAt!.getTime() - entry.clockedInAt.getTime()) / HOUR).toBeCloseTo(8, 1);
  });
});

describe("the job timer", () => {
  it("runs on one job at a time, clocks you in, and stops when you clock out", async () => {
    const first = await visit("Gutters");
    const second = await visit("Fence");
    const who = { organizationId, userId: crewId };

    await startTimer(who, first.id, new Date(Date.now() - 2 * HOUR));
    expect(await openClocks()).toHaveLength(1);
    await startTimer(who, second.id);

    const entries = await prisma.timeEntry.findMany({ where: { organizationId }, orderBy: { startedAt: "asc" } });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ jobId: first.id, minutes: 120, hourlyRateCents: 3000 });
    expect(entries[1]).toMatchObject({ jobId: second.id, endedAt: null });

    await clockOutNow(IDLE, form({}));
    expect(await openTimers()).toHaveLength(0);
    expect(await openClocks()).toHaveLength(0);
  });

  it("cannot count a phone left running over the weekend", async () => {
    const job = await visit("Roof");
    const who = { organizationId, userId: crewId };
    await startTimer(who, job.id, new Date(Date.now() - 60 * HOUR));
    expect(await stopTimer(who)).toBe(TIMER_MAX_MINUTES);
  });
});

describe("starting and finishing a visit", () => {
  it("lets the crew start their own visit: the timer runs and the job is in progress", async () => {
    const job = await visit("Gutters");
    expect(await startVisit(IDLE, form({ jobId: job.id }))).toMatchObject({ ok: true });
    expect(await statusOf(job.id)).toBe("IN_PROGRESS");
    expect(await openTimers()).toMatchObject([{ jobId: job.id, userId: crewId }]);

    await stopVisitTimer(IDLE);
    expect(await openTimers()).toHaveLength(0);
  });

  it("refuses somebody else's visit", async () => {
    const other = await person("Other Crew", "EMPLOYEE");
    const theirs = await visit("Not mine", { assign: [other] });
    expect(await startVisit(IDLE, form({ jobId: theirs.id }))).toMatchObject({ ok: false });
    expect(await completeVisit(IDLE, form({ jobId: theirs.id }))).toMatchObject({ ok: false });
    expect(await statusOf(theirs.id)).toBe("SCHEDULED");
    expect(await openTimers()).toHaveLength(0);
  });

  it("finishes a visit straight from booked, stopping its timer — with checklist items still open", async () => {
    const job = await visit("Siding");
    await prisma.jobChecklistItem.create({ data: { organizationId, jobId: job.id, label: "After photos" } });
    await startTimer({ organizationId, userId: crewId }, job.id, new Date(Date.now() - HOUR));

    expect(await completeVisit(IDLE, form({ jobId: job.id }))).toMatchObject({ ok: true });
    const done = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe("COMPLETED");
    expect(done.startedAt).not.toBeNull();
    expect(done.completedAt).not.toBeNull();
    expect(await openTimers()).toHaveLength(0);
  });

  it("lets the office finish a job it is not on", async () => {
    const job = await visit("Office closes it", { status: "IN_PROGRESS" });
    await signInAs(managerId);
    expect(await completeVisit(IDLE, form({ jobId: job.id }))).toMatchObject({ ok: true });
    expect(await statusOf(job.id)).toBe("COMPLETED");
  });
});

describe("the day screen", () => {
  it("shows this person's visits today, work of theirs still open from before, and their hours", async () => {
    const other = await person("Other Crew", "EMPLOYEE");
    await visit("Mine today");
    await visit("Cancelled today", { status: "CANCELLED" });
    await visit("Theirs today", { assign: [other] });
    await visit("Mine tomorrow", { start: new Date(Date.now() + 30 * HOUR) });
    await visit("Started yesterday", { start: new Date(Date.now() - 30 * HOUR), status: "IN_PROGRESS" });
    await prisma.clockEntry.create({
      data: { organizationId, userId: crewId, clockedInAt: new Date(Date.now() - 90 * 60 * 1000) },
    });

    const day = await myDay(organizationId, crewId, "UTC");
    // Near midnight the clock entry may have begun yesterday, and then counts
    // towards yesterday's hours instead.
    expect(day.today.map((v) => v.title)).toEqual(["Mine today"]);
    expect(day.carriedOver.map((v) => v.title)).toEqual(["Started yesterday"]);
    expect(day.clock).not.toBeNull();
    expect(day.minutesToday).toBeLessThanOrEqual(91);
  });

  it("is the crew's home: they get My Day and not the business dashboard", () => {
    const items = NAVIGATION.flatMap((group) => group.items);
    const visible = (role: string) =>
      items.filter((item) => can({ role } as never, item.permission)).map((item) => item.href);
    expect(visible("EMPLOYEE")).toContain("/my-day");
    expect(visible("EMPLOYEE")).not.toContain("/dashboard");
    expect(visible("MANAGER")).toEqual(expect.arrayContaining(["/dashboard", "/my-day"]));
  });
});

describe("fixing the clock", () => {
  it("is for whoever schedules the crews, not the crew themselves", async () => {
    const entry = await prisma.clockEntry.create({
      data: { organizationId, userId: crewId, clockedInAt: new Date(Date.now() - 10 * HOUR) },
    });
    const local = (date: Date) => date.toISOString().slice(0, 16);
    const fix = (fields: Record<string, string>) => fixClockEntry(IDLE, form({ id: entry.id, ...fields }));

    await expect(fix({ in: local(new Date(Date.now() - 9 * HOUR)) })).rejects.toThrow(/jobs:assign/);

    await signInAs(managerId);
    expect(await fix({ in: local(new Date(Date.now() - 9 * HOUR)), out: local(new Date(Date.now() - 10 * HOUR)) })).toMatchObject({
      fieldErrors: { out: "That is before they started." },
    });
    expect(await fix({ in: local(new Date(Date.now() - 9 * HOUR)), out: local(new Date(Date.now() - HOUR)) })).toMatchObject({
      ok: true,
    });
    const fixed = await prisma.clockEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(fixed).toMatchObject({ editedById: managerId });
    expect((fixed.clockedOutAt!.getTime() - fixed.clockedInAt.getTime()) / HOUR).toBeCloseTo(8, 1);
  });
});

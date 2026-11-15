import { randomUUID } from "node:crypto";

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Timesheets, and the clock that offers a job.
 *
 * What is pinned: a span of days is a Sunday-to-Saturday week unless two
 * dates say otherwise, starts and stops at midnight on the viewer's clock,
 * and steps by its own length; a person's sheet adds up each day, the span
 * and where the time went, counts a shift on the day it began, and never lets
 * job time on an unclocked day cancel clocked time on another; clocking in
 * needs no job and takes any open job the person can see — theirs for the
 * crew, anybody's for the office — without calling a visit started; a stretch
 * entered or fixed by the office cannot overlap another of the same person's,
 * and closing one stops the timer; and the crew read their own sheet and
 * nobody else's.
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
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import MyHoursPage from "@/app/(app)/my-day/hours/page";
import { clockInNow, clockOutNow, workOnJob } from "@/app/(app)/my-day/actions";
import { jobChoices } from "@/app/(app)/my-day/queries";
import PersonTimesheetPage from "@/app/(app)/team/time-clock/[id]/page";
import { addClockEntry, fixClockEntry } from "@/app/(app)/team/time-clock/actions";
import TimeClockPage from "@/app/(app)/team/time-clock/page";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import { startTimer, TIMER_MAX_MINUTES } from "@/lib/time-clock";
import {
  columnMinutes,
  entryDefaults,
  loadTimesheets,
  rangeLabel,
  timesheetColumns,
  timesheetPresets,
  timesheetRange,
  TIMESHEET_MAX_DAYS,
} from "@/lib/timesheet";

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

async function person(name: string, role: string) {
  const user = await prisma.user.create({
    data: { organizationId, email: `${randomUUID()}@test.local`, name, passwordHash: "x", role, hourlyRateCents: 3000 },
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

/** A stretch on the clock, written straight into the table. */
const clock = (userId: string, clockedInAt: Date, clockedOutAt: Date | null) =>
  prisma.clockEntry.create({ data: { organizationId, userId, clockedInAt, clockedOutAt } });

/** Time on a job: `minutes` of it, or a timer still running when `minutes` is null. */
const jobTime = (userId: string, jobId: string, startedAt: Date, minutes: number | null) =>
  prisma.timeEntry.create({
    data: {
      organizationId,
      userId,
      jobId,
      startedAt,
      endedAt: minutes === null ? null : new Date(startedAt.getTime() + minutes * 60_000),
      minutes: minutes ?? 0,
    },
  });

/** A moment in the week of March 1, 2026 — far enough back that "now" never touches it. */
const at = (day: string, time: string) => new Date(`${day}T${time}:00Z`);
/** `hours` ago, on the minute: the forms carry no seconds. */
const ago = (hours: number) => new Date(Math.floor((Date.now() - hours * HOUR) / 60_000) * 60_000);
const local = (date: Date) => date.toISOString().slice(0, 16);

const statusOf = async (jobId: string) => (await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status;
const openTimers = () => prisma.timeEntry.findMany({ where: { organizationId, endedAt: null } });
const openClocks = () => prisma.clockEntry.findMany({ where: { organizationId, clockedOutAt: null } });
const MARCH = { from: "2026-03-01", to: "2026-03-07" };

beforeEach(async () => {
  const org = await prisma.organization.create({
    data: { slug: `sheet-${randomUUID()}`, name: "Sheet Test Co", timeZone: "UTC" },
  });
  orgs.push(org.id);
  organizationId = org.id;
  crewId = await person("Sam Crew", "EMPLOYEE");
  managerId = await person("Max Manager", "MANAGER");
  await signInAs(crewId);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

describe("the span of days", () => {
  beforeEach(() => {
    // A Wednesday. Its week runs Sunday the 8th to Saturday the 14th.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T15:00:00Z"));
  });

  it("is this Sunday-to-Saturday week when nothing is asked for, midnight to midnight", () => {
    const range = timesheetRange({}, "UTC");
    expect(range).toMatchObject({ from: "2026-11-08", to: "2026-11-14" });
    expect(range.days).toEqual([
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
    ]);
    expect(range.start.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-11-15T00:00:00.000Z");
    expect(range.previous).toEqual({ from: "2026-11-01", to: "2026-11-07" });
    expect(range.next).toEqual({ from: "2026-11-15", to: "2026-11-21" });
  });

  it("reads today and midnight on the viewer's clock, through a daylight-saving change", () => {
    // 3 AM Sunday in UTC is still Saturday evening in New York: last week there.
    vi.setSystemTime(new Date("2026-11-08T03:00:00Z"));
    expect(timesheetRange({}, "UTC").from).toBe("2026-11-08");

    const range = timesheetRange({}, "America/New_York");
    expect(range).toMatchObject({ from: "2026-11-01", to: "2026-11-07" });
    // The clocks went back on the 1st, so this week is an hour longer.
    expect(range.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-11-08T05:00:00.000Z");
  });

  it("still opens the week an old link named", () => {
    expect(timesheetRange({ week: "2026-10-21" }, "UTC")).toMatchObject({ from: "2026-10-18", to: "2026-10-24" });
  });

  it("takes any two dates, either way round, and steps by its own length", () => {
    const range = timesheetRange({ from: "2026-11-14", to: "2026-11-01" }, "UTC");
    expect(range).toMatchObject({ from: "2026-11-01", to: "2026-11-14" });
    expect(range.days).toHaveLength(14);
    expect(range.previous).toEqual({ from: "2026-10-18", to: "2026-10-31" });
    expect(range.next).toEqual({ from: "2026-11-15", to: "2026-11-28" });

    expect(timesheetRange({ from: "2026-11-05" }, "UTC")).toMatchObject({ from: "2026-11-05", to: "2026-11-05" });
  });

  it("steps a whole calendar month by months, whatever their lengths", () => {
    const november = timesheetRange({ from: "2026-11-01", to: "2026-11-30" }, "UTC");
    expect(november.previous).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(november.next).toEqual({ from: "2026-12-01", to: "2026-12-31" });

    const february = timesheetRange({ from: "2027-02-01", to: "2027-02-28" }, "UTC");
    expect(february.previous).toEqual({ from: "2027-01-01", to: "2027-01-31" });
    expect(february.next).toEqual({ from: "2027-03-01", to: "2027-03-31" });
  });

  it("cuts a span that is too long, and falls back to this week on dates that are not dates", () => {
    const year = timesheetRange({ from: "2026-01-01", to: "2026-12-31" }, "UTC");
    expect(year.days).toHaveLength(TIMESHEET_MAX_DAYS);
    expect(year).toMatchObject({ from: "2026-01-01", to: "2026-03-03" });

    expect(timesheetRange({ from: "2026-02-31", to: "soon" }, "UTC")).toMatchObject({
      from: "2026-11-08",
      to: "2026-11-14",
    });
  });

  it("offers the spans people ask for by name", () => {
    expect(timesheetPresets("UTC")).toEqual([
      { label: "This week", from: "2026-11-08", to: "2026-11-14" },
      { label: "Last week", from: "2026-11-01", to: "2026-11-07" },
      { label: "Last 2 weeks", from: "2026-10-25", to: "2026-11-07" },
      { label: "This month", from: "2026-11-01", to: "2026-11-30" },
      { label: "Last month", from: "2026-10-01", to: "2026-10-31" },
    ]);
  });

  it("gives the team table a column a day up to two weeks, and a column a week past that", () => {
    const week = timesheetColumns(timesheetRange({}, "UTC"));
    expect(week.map((column) => column.label)).toEqual(["Sun 8", "Mon 9", "Tue 10", "Wed 11", "Thu 12", "Fri 13", "Sat 14"]);

    const fortnight = timesheetColumns(timesheetRange({ from: "2026-11-01", to: "2026-11-14" }, "UTC"));
    expect(fortnight).toHaveLength(14);

    // October 2026 starts on a Thursday: the first column is a short week.
    const october = timesheetColumns(timesheetRange({ from: "2026-10-01", to: "2026-10-31" }, "UTC"));
    expect(october.map((column) => column.label)).toEqual(["Oct 1–3", "Oct 4–10", "Oct 11–17", "Oct 18–24", "Oct 25–31"]);
    expect(october.flatMap((column) => column.dates)).toHaveLength(31);

    const newYear = timesheetColumns(timesheetRange({ from: "2026-12-20", to: "2027-01-09" }, "UTC"));
    expect(newYear.map((column) => column.label)).toEqual(["Dec 20–26", "Dec 27–Jan 2", "Jan 3–9"]);
  });

  it("names a span the way a person would", () => {
    expect(rangeLabel({ from: "2026-11-08", to: "2026-11-14" })).toBe("Nov 8 – Nov 14, 2026");
    expect(rangeLabel({ from: "2026-12-27", to: "2027-01-02" })).toBe("Dec 27, 2026 – Jan 2, 2027");
    expect(rangeLabel({ from: "2026-11-05", to: "2026-11-05" })).toBe("Thu, Nov 5, 2026");
  });

  it("starts an entry-by-hand from times that have already happened", () => {
    // Wednesday 3 PM: eight this morning has been, four this afternoon has not.
    expect(entryDefaults({ from: "2026-11-08", to: "2026-11-14" }, "UTC")).toEqual({
      defaultIn: "2026-11-11T08:00",
      defaultOut: "",
    });
    // A week that is over: its last day, start to finish.
    expect(entryDefaults({ from: "2026-11-01", to: "2026-11-07" }, "UTC")).toEqual({
      defaultIn: "2026-11-07T08:00",
      defaultOut: "2026-11-07T16:00",
    });
  });
});

describe("a person's sheet", () => {
  it("adds up each day, the span, and where the time went", async () => {
    const gutters = await visit("Gutters");
    const fence = await visit("Fence");

    // Monday: 8½ hours on the clock, five of them on two jobs.
    await clock(crewId, at("2026-03-02", "07:00"), at("2026-03-02", "15:30"));
    await jobTime(crewId, gutters.id, at("2026-03-02", "07:30"), 180);
    await jobTime(crewId, fence.id, at("2026-03-02", "11:00"), 120);
    // Tuesday: out for lunch, so two stretches.
    await clock(crewId, at("2026-03-03", "07:00"), at("2026-03-03", "11:00"));
    await clock(crewId, at("2026-03-03", "12:00"), at("2026-03-03", "15:00"));
    await jobTime(crewId, gutters.id, at("2026-03-03", "08:00"), 90);
    // Wednesday: never clocked in; the office logged two hours on the fence.
    await jobTime(crewId, fence.id, at("2026-03-04", "09:00"), 120);
    // Thursday night into Friday morning: Thursday's shift.
    await clock(crewId, at("2026-03-05", "22:00"), at("2026-03-06", "02:00"));
    // The week before, and somebody else's hour: neither is Sam's week.
    await clock(crewId, at("2026-02-27", "07:00"), at("2026-02-27", "15:00"));
    await clock(managerId, at("2026-03-02", "09:00"), at("2026-03-02", "10:00"));

    const range = timesheetRange(MARCH, "UTC");
    const sheets = await loadTimesheets({ organizationId, range, zone: "UTC" });
    expect(sheets.map((sheet) => sheet.person.name)).toEqual(["Max Manager", "Sam Crew"]);

    const sam = sheets[1];
    expect(sam).toMatchObject({ clockMinutes: 510 + 420 + 240, jobMinutes: 510, daysWorked: 4, onClock: false });
    expect([...sam.days.keys()].sort()).toEqual(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]);
    expect(sam.days.get("2026-03-03")).toMatchObject({ clockMinutes: 420, jobMinutes: 90 });
    expect(sam.days.get("2026-03-03")!.stretches).toHaveLength(2);
    expect(sam.days.get("2026-03-05")).toMatchObject({ clockMinutes: 240 });
    expect(sam.byJob.map((job) => [job.title, job.minutes])).toEqual([
      ["Gutters", 270],
      ["Fence", 240],
    ]);

    // Wednesday's job time has no clock under it, and must not eat into the
    // other days' time off a job: 210 + 330 + 0 + 240.
    expect(sam.days.get("2026-03-04")).toMatchObject({ clockMinutes: 0, jobMinutes: 120, stretches: [] });
    expect(sam.offJobMinutes).toBe(780);

    const monday = timesheetColumns(range)[1];
    expect(monday.label).toBe("Mon 2");
    expect(columnMinutes(sam, monday)).toEqual({ clock: 510, job: 300 });

    const own = await loadTimesheets({ organizationId, range, zone: "UTC", userId: crewId });
    expect(own.map((sheet) => sheet.person.name)).toEqual(["Sam Crew"]);
  });

  it("counts somebody still on the clock up to now, a running timer no further than its cap, and flags a forgotten clock-out", async () => {
    const roof = await visit("Roof");
    const now = at("2026-03-04", "12:00");

    // Sam clocked in this morning and started a timer with it.
    await clock(crewId, at("2026-03-04", "07:00"), null);
    await jobTime(crewId, roof.id, at("2026-03-04", "07:00"), null);
    // Max clocked in on Monday and never clocked out; nor did the timer stop.
    await clock(managerId, at("2026-03-02", "08:00"), null);
    await jobTime(managerId, roof.id, at("2026-03-02", "08:00"), null);

    const [max, sam] = await loadTimesheets({
      organizationId,
      range: timesheetRange(MARCH, "UTC"),
      zone: "UTC",
      now,
    });

    expect(sam).toMatchObject({ clockMinutes: 300, jobMinutes: 300, offJobMinutes: 0, onClock: true });
    expect(sam.days.get("2026-03-04")!.stretches[0]).toMatchObject({ clockedOutAt: null, forgotten: false });
    expect(sam.days.get("2026-03-04")!.jobTimes[0]).toMatchObject({ running: true, minutes: 300 });

    expect(max.days.get("2026-03-02")!.stretches[0]).toMatchObject({ forgotten: true });
    expect(max.jobMinutes).toBe(TIMER_MAX_MINUTES);
  });
});

describe("clocking in", () => {
  it("needs no job, and takes one when it is named — without calling the visit started", async () => {
    const job = await visit("Gutters");

    expect(await clockInNow(IDLE, form({ jobId: "" }))).toMatchObject({ ok: true, message: "Clocked in." });
    expect(await openClocks()).toHaveLength(1);
    expect(await openTimers()).toHaveLength(0);
    await clockOutNow(IDLE, form({}));

    expect(await clockInNow(IDLE, form({ jobId: job.id }))).toMatchObject({ ok: true, message: "Clocked in." });
    expect(await openClocks()).toHaveLength(1);
    expect(await openTimers()).toMatchObject([{ jobId: job.id, userId: crewId, hourlyRateCents: 3000 }]);
    expect(await statusOf(job.id)).toBe("SCHEDULED");
  });

  it("refuses a job that is somebody else's or already finished, and leaves them off the clock", async () => {
    const other = await person("Other Crew", "EMPLOYEE");
    const theirs = await visit("Not mine", { assign: [other] });
    const done = await visit("Done last week", { status: "COMPLETED" });

    expect(await clockInNow(IDLE, form({ jobId: theirs.id }))).toMatchObject({ ok: false });
    expect(await clockInNow(IDLE, form({ jobId: done.id }))).toMatchObject({ ok: false });
    expect(await openClocks()).toHaveLength(0);
    expect(await openTimers()).toHaveLength(0);
  });
});

describe("saying what the time is going on", () => {
  it("puts the timer on any open job of theirs, not only today's, and moves it from one to the next", async () => {
    const nextWeek = await visit("Next week", { start: new Date(Date.now() + 7 * 24 * HOUR) });
    const unbooked = await visit("Never booked", { start: null });

    expect(await workOnJob(IDLE, form({ jobId: nextWeek.id }))).toMatchObject({ ok: true, message: "Timer started." });
    // It clocked them in.
    expect(await openClocks()).toHaveLength(1);

    expect(await workOnJob(IDLE, form({ jobId: unbooked.id }))).toMatchObject({ ok: true });
    expect(await openTimers()).toMatchObject([{ jobId: unbooked.id }]);
    expect(await prisma.timeEntry.count({ where: { jobId: nextWeek.id, endedAt: { not: null } } })).toBe(1);
    expect(await openClocks()).toHaveLength(1);

    // Naming a job is not starting a visit.
    expect(await statusOf(nextWeek.id)).toBe("SCHEDULED");
    expect(await statusOf(unbooked.id)).toBe("SCHEDULED");
  });

  it("asks which job, and refuses one that is called off or not theirs to see", async () => {
    const other = await person("Other Crew", "EMPLOYEE");
    const theirs = await visit("Not mine", { assign: [other] });
    const off = await visit("Called off", { status: "CANCELLED" });

    expect(await workOnJob(IDLE, form({}))).toMatchObject({ ok: false, fieldErrors: { jobId: expect.any(String) } });
    expect(await workOnJob(IDLE, form({ jobId: theirs.id }))).toMatchObject({ ok: false });
    expect(await workOnJob(IDLE, form({ jobId: off.id }))).toMatchObject({ ok: false });
    expect(await openTimers()).toHaveLength(0);
    expect(await openClocks()).toHaveLength(0);
  });

  it("lets the office time a job it is not on", async () => {
    const job = await visit("The crew's job");
    await signInAs(managerId);
    expect(await workOnJob(IDLE, form({ jobId: job.id }))).toMatchObject({ ok: true });
    expect(await openTimers()).toMatchObject([{ jobId: job.id, userId: managerId }]);
  });
});

describe("the jobs the clock offers", () => {
  it("is every open job they can see, nearest first, and nothing else", async () => {
    const other = await person("Other Crew", "EMPLOYEE");
    await visit("On today");
    await visit("Next week", { start: new Date(Date.now() + 7 * 24 * HOUR) });
    await visit("Open since last week", { start: new Date(Date.now() - 7 * 24 * HOUR), status: "IN_PROGRESS" });
    await visit("Never booked", { start: null });
    await visit("Finished", { status: "COMPLETED" });
    await visit("Called off", { status: "CANCELLED" });
    await visit("Somebody else's", { assign: [other] });

    const titles = (groups: Awaited<ReturnType<typeof jobChoices>>) =>
      groups.flatMap((group) => group.jobs).map((job) => job.label.replace(/^J-\d+ · /, "").replace(/ \(.*\)$/, ""));

    const mine = await jobChoices(organizationId, { role: "EMPLOYEE", id: crewId }, "UTC");
    expect(mine.map((group) => group.label)).toEqual(["Today", "Coming up", "Still open from before", "Not booked yet"]);
    expect(titles(mine)).toEqual(["On today", "Next week", "Open since last week", "Never booked"]);

    // The office can see the other crew's job; an employee cannot.
    const office = await jobChoices(organizationId, { role: "MANAGER", id: managerId }, "UTC");
    expect(titles(office)).toEqual(expect.arrayContaining(["On today", "Somebody else's"]));
    expect(titles(office)).not.toEqual(expect.arrayContaining(["Finished"]));
    expect(titles(office)).not.toEqual(expect.arrayContaining(["Called off"]));
  });
});

describe("entering a stretch by hand", () => {
  const add = (fields: Record<string, string>) => addClockEntry(IDLE, form({ userId: crewId, ...fields }));

  it("is for whoever schedules the crews, not the crew themselves", async () => {
    await expect(add({ in: local(ago(9)), out: local(ago(1)) })).rejects.toThrow(/jobs:assign/);
    expect(await prisma.clockEntry.count({ where: { organizationId } })).toBe(0);
  });

  it("checks the times as a fix does, and writes down who entered it", async () => {
    await signInAs(managerId);

    expect(await addClockEntry(IDLE, form({ userId: "nobody", in: local(ago(9)) }))).toMatchObject({
      fieldErrors: { userId: "Pick who it is for." },
    });
    expect(await add({})).toMatchObject({ fieldErrors: { in: "Pick when they started." } });
    expect(await add({ in: local(new Date(Date.now() + 2 * HOUR)) })).toMatchObject({
      fieldErrors: { in: "That is still to come." },
    });
    expect(await add({ in: local(ago(9)), out: local(ago(10)) })).toMatchObject({
      fieldErrors: { out: "That is before they started." },
    });
    expect(await add({ in: local(ago(40)), out: local(ago(10)) })).toMatchObject({
      fieldErrors: { out: "One entry covers a day at most. Add the next day separately." },
    });
    expect(await prisma.clockEntry.count({ where: { organizationId } })).toBe(0);

    const start = ago(9);
    const stop = new Date(start.getTime() + 8 * HOUR);
    expect(await add({ in: local(start), out: local(stop) })).toMatchObject({ ok: true, message: "Added." });
    const [entry] = await prisma.clockEntry.findMany({ where: { organizationId } });
    expect(entry).toMatchObject({ userId: crewId, editedById: managerId });
    expect((entry.clockedOutAt!.getTime() - entry.clockedInAt.getTime()) / HOUR).toBe(8);
  });

  it("refuses a stretch that runs into another of the same person's", async () => {
    await clock(crewId, ago(9), ago(5));
    await signInAs(managerId);

    expect(await add({ in: local(ago(6)), out: local(ago(2)) })).toMatchObject({
      ok: false,
      error: expect.stringContaining("That runs into their entry from"),
    });
    // Around it on both sides swallows it whole.
    expect(await add({ in: local(ago(10)), out: local(ago(4)) })).toMatchObject({ ok: false });
    expect(await prisma.clockEntry.count({ where: { organizationId } })).toBe(1);

    // Starting the minute the other ended is not an overlap.
    expect(await add({ in: local(ago(5)), out: local(ago(2)) })).toMatchObject({ ok: true });
    // And the same hours for somebody else are nobody's overlap.
    expect(
      await addClockEntry(IDLE, form({ userId: managerId, in: local(ago(6)), out: local(ago(2)) })),
    ).toMatchObject({ ok: true });
  });

  it("puts somebody on the clock who never clocked in — once", async () => {
    await signInAs(managerId);

    expect(await add({ in: local(ago(3)) })).toMatchObject({ ok: true });
    expect(await openClocks()).toMatchObject([{ userId: crewId, editedById: managerId }]);

    expect(await add({ in: local(ago(1)) })).toMatchObject({
      ok: false,
      error: expect.stringContaining("still clocked in"),
    });
    expect(await openClocks()).toHaveLength(1);
  });
});

describe("fixing a stretch", () => {
  it("refuses times that run into another of theirs", async () => {
    await clock(crewId, ago(10), ago(6));
    const began = ago(5);
    const afternoon = await clock(crewId, began, ago(1));
    await signInAs(managerId);
    const fix = (fields: Record<string, string>) => fixClockEntry(IDLE, form({ id: afternoon.id, ...fields }));

    expect(await fix({ in: local(ago(7)), out: local(ago(1)) })).toMatchObject({
      ok: false,
      error: expect.stringContaining("That runs into their entry from"),
    });
    const untouched = await prisma.clockEntry.findUniqueOrThrow({ where: { id: afternoon.id } });
    expect(untouched.clockedInAt.getTime()).toBe(began.getTime());
    expect(untouched.editedById).toBeNull();

    // Moved right up against the morning is fine: an entry is not its own overlap.
    expect(await fix({ in: local(ago(6)), out: local(ago(2)) })).toMatchObject({ ok: true });
  });

  it("stops a timer left running when it closes somebody's stretch", async () => {
    const job = await visit("Roof");
    const start = ago(5);
    const stop = new Date(start.getTime() + 3 * HOUR);
    await startTimer({ organizationId, userId: crewId }, job.id, start);
    const [open] = await openClocks();

    await signInAs(managerId);
    expect(await fixClockEntry(IDLE, form({ id: open.id, in: local(start), out: local(stop) }))).toMatchObject({
      ok: true,
    });

    expect(await openClocks()).toHaveLength(0);
    expect(await openTimers()).toHaveLength(0);
    const [timed] = await prisma.timeEntry.findMany({ where: { organizationId } });
    expect(timed.minutes).toBe(180);
  });
});

describe("who reads which sheet", () => {
  const html = async (page: Promise<ReactElement>) => renderToStaticMarkup(await page);

  beforeEach(async () => {
    await clock(crewId, at("2026-03-02", "07:00"), at("2026-03-02", "15:30"));
    await clock(managerId, at("2026-03-03", "09:00"), at("2026-03-03", "10:15"));
  });

  it("shows the office everybody's hours, each name leading to that person's sheet", async () => {
    await signInAs(managerId);
    const page = await html(TimeClockPage({ searchParams: Promise.resolve(MARCH) }));

    expect(page).toContain("Mar 1 – Mar 7, 2026");
    expect(page).toContain("Mon 2");
    expect(page).toContain(`href="/team/time-clock/${crewId}?from=2026-03-01&amp;to=2026-03-07"`);
    expect(page).toContain("8h 30m");
    expect(page).toContain("1h 15m");
    // The two together, on the Everyone line.
    expect(page).toContain("9h 45m");
    // A manager schedules the crews, so may fix and add.
    expect(page).toContain("Add an entry");

    const sam = await html(
      PersonTimesheetPage({ params: Promise.resolve({ id: crewId }), searchParams: Promise.resolve(MARCH) }),
    );
    expect(sam).toContain("Sam Crew");
    expect(sam).toContain("7:00 AM – 3:30 PM");
    expect(sam).not.toContain("1h 15m");
  });

  it("keeps the team's hours from the crew, and gives them their own", async () => {
    await expect(TimeClockPage({ searchParams: Promise.resolve(MARCH) })).rejects.toThrow(/employees:read/);
    await expect(
      PersonTimesheetPage({ params: Promise.resolve({ id: managerId }), searchParams: Promise.resolve(MARCH) }),
    ).rejects.toThrow(/employees:read/);

    const mine = await html(MyHoursPage({ searchParams: Promise.resolve(MARCH) }));
    expect(mine).toContain("My hours");
    expect(mine).toContain("7:00 AM – 3:30 PM");
    expect(mine).toContain("8h 30m");
    // Nobody else's, and nothing to change it with.
    expect(mine).not.toContain("1h 15m");
    expect(mine).not.toContain("Fix");
    expect(mine).not.toContain("Add an entry");
  });

  it("does not open a sheet for somebody in another business", async () => {
    await signInAs(managerId);
    const elsewhere = await prisma.organization.create({ data: { slug: `sheet-${randomUUID()}`, name: "Elsewhere" } });
    orgs.push(elsewhere.id);
    const stranger = await prisma.user.create({
      data: { organizationId: elsewhere.id, email: `${randomUUID()}@test.local`, name: "A Stranger", passwordHash: "x", role: "EMPLOYEE" },
    });

    await expect(
      PersonTimesheetPage({ params: Promise.resolve({ id: stranger.id }), searchParams: Promise.resolve(MARCH) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

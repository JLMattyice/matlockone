import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who a calendar feed shows what to, against the real database.
 *
 * A feed is fetched with no session, so everything the sign-in normally
 * decides is decided here from the token alone: whose schedule, how much of
 * it, and whether it should answer at all. The failures worth pinning are the
 * quiet ones — a technician's feed carrying the whole business, a removed
 * employee's phone still updating, a lapsed business still publishing.
 */

const session = vi.hoisted(() => ({
  user: null as unknown as Record<string, unknown>,
  org: null as unknown as Record<string, unknown>,
}));

vi.mock("@/lib/auth", () => ({
  requireContext: async () => session,
  requirePermission: async () => session,
  getContext: async () => session,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  resetCalendarFeed,
  turnOffCalendarFeed,
  turnOnCalendarFeed,
} from "@/app/(app)/settings/profile/calendar-feed-actions";
import { IDLE } from "@/lib/action-state";
import { loadFeed, newFeedToken } from "@/lib/calendar-feed-server";
import { prisma } from "@/lib/db";

const NOW = new Date("2026-10-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let organizationId: string;
let ownerToken: string;
let techToken: string;
let techId: string;

async function person(role: string, name: string) {
  const token = newFeedToken();
  const user = await prisma.user.create({
    data: {
      organizationId,
      email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
      name,
      passwordHash: "x",
      role,
      calendarFeedToken: token,
    },
  });
  return { user, token };
}

async function job(number: string, data: { start: Date; status?: string; assignee?: string }) {
  const created = await prisma.job.create({
    data: {
      organizationId,
      number,
      title: `Entry ${number}`,
      status: data.status ?? "SCHEDULED",
      scheduledStart: data.start,
      scheduledEnd: new Date(data.start.getTime() + 2 * 60 * 60 * 1000),
    },
  });
  if (data.assignee) {
    await prisma.jobAssignment.create({ data: { jobId: created.id, userId: data.assignee } });
  }
  return created;
}

/** The job numbers in a feed, by the UIDs it carries. */
async function numbersIn(token: string, all: boolean) {
  const feed = await loadFeed(token, all, NOW);
  if (feed.kind !== "ok") return feed.kind;

  const ids = [...feed.body.matchAll(/^UID:([^@]+)@/gm)].map((match) => match[1]);
  const jobs = await prisma.job.findMany({ where: { id: { in: ids } }, select: { number: true } });
  return jobs.map((row) => row.number).sort();
}

beforeEach(async () => {
  const org = await prisma.organization.create({
    data: { slug: `feed-${randomUUID()}`, name: "Feed Test Co", billingExempt: true },
  });
  organizationId = org.id;

  const owner = await person("OWNER", "Morgan Hale");
  const tech = await person("EMPLOYEE", "Priya Raghavan");
  ownerToken = owner.token;
  techToken = tech.token;
  techId = tech.user.id;

  session.org = org;
  session.user = tech.user;

  await job("J-1", { start: new Date(NOW.getTime() + DAY), assignee: techId });
  await job("J-2", { start: new Date(NOW.getTime() + 2 * DAY) });
  await job("J-3", {
    start: new Date(NOW.getTime() + 3 * DAY),
    status: "CANCELLED",
    assignee: techId,
  });
  await job("J-4", { start: new Date(NOW.getTime() + 900 * DAY), assignee: techId });
});

describe("what a feed shows", () => {
  it("gives a technician their own work and nothing else", async () => {
    expect(await numbersIn(techToken, false)).toEqual(["J-1"]);
  });

  it("does not widen a technician's feed when they ask for everything", async () => {
    expect(await numbersIn(techToken, true)).toEqual(["J-1"]);
  });

  it("gives an owner the whole schedule on the -all feed", async () => {
    expect(await numbersIn(ownerToken, true)).toEqual(["J-1", "J-2"]);
  });

  it("gives an owner only their own on the personal feed", async () => {
    // Nothing is assigned to the owner: an empty, still valid, calendar.
    expect(await numbersIn(ownerToken, false)).toEqual([]);
  });

  it("leaves out cancelled entries and ones far beyond the window", async () => {
    const shown = await numbersIn(ownerToken, true);
    expect(shown).not.toContain("J-3");
    expect(shown).not.toContain("J-4");
  });
});

describe("when a feed stops answering", () => {
  it("knows nothing of a token nobody holds", async () => {
    expect((await loadFeed(newFeedToken(), false, NOW)).kind).toBe("missing");
  });

  it("goes quiet for somebody who has been deactivated", async () => {
    await prisma.user.update({ where: { id: techId }, data: { isActive: false } });
    expect((await loadFeed(techToken, false, NOW)).kind).toBe("missing");
  });

  it("pauses while the business is unpaid", async () => {
    await prisma.organization.update({
      where: { id: organizationId },
      data: { billingExempt: false },
    });
    expect((await loadFeed(techToken, false, NOW)).kind).toBe("locked");
  });
});

describe("turning the link on, over and off", () => {
  async function tokenNow() {
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: techId },
      select: { calendarFeedToken: true },
    });
    return row.calendarFeedToken;
  }

  it("keeps the same link when turned on twice", async () => {
    await prisma.user.update({ where: { id: techId }, data: { calendarFeedToken: null } });

    await turnOnCalendarFeed(IDLE);
    const first = await tokenNow();
    await turnOnCalendarFeed(IDLE);

    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await tokenNow()).toBe(first);
  });

  it("makes the old link stop working when a new one is made", async () => {
    await resetCalendarFeed(IDLE);
    const fresh = await tokenNow();

    expect(fresh).not.toBe(techToken);
    expect((await loadFeed(techToken, false, NOW)).kind).toBe("missing");
    expect((await loadFeed(fresh!, false, NOW)).kind).toBe("ok");
  });

  it("cuts the link off when turned off", async () => {
    await turnOffCalendarFeed(IDLE);

    expect(await tokenNow()).toBeNull();
    expect((await loadFeed(techToken, false, NOW)).kind).toBe("missing");
  });
});

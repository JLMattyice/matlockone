import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/lib/db";

import {
  assignableGroups,
  leadOf,
  realMemberIds,
} from "@/app/(app)/team/groups/queries";

/**
 * Groups of staff.
 *
 * The rules worth pinning are the ones about *other people's* data and about
 * history: a group must not be able to reach across businesses, and retiring
 * one must never quietly rewrite who did last month's work. These run against
 * the real database because every one of them is a constraint the database is
 * responsible for.
 */

const prisma = createPrismaClient();

let orgId: string;
let otherOrgId: string;
let alice: string;
let bob: string;
let outsider: string;

async function makeUser(organizationId: string, name: string) {
  const user = await prisma.user.create({
    data: {
      organizationId,
      email: `${randomUUID()}@test.local`,
      name,
      passwordHash: "not-used",
      role: "EMPLOYEE",
    },
  });
  return user.id;
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { slug: `groups-${randomUUID()}`, name: "Groups Test Co" },
  });
  orgId = org.id;

  const other = await prisma.organization.create({
    data: { slug: `groups-other-${randomUUID()}`, name: "Someone Else Ltd" },
  });
  otherOrgId = other.id;

  alice = await makeUser(orgId, "Alice");
  bob = await makeUser(orgId, "Bob");
  outsider = await makeUser(otherOrgId, "Outsider");
});

afterAll(async () => {
  await prisma.organization.deleteMany({
    where: { id: { in: [orgId, otherOrgId] } },
  });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.group.deleteMany({ where: { organizationId: orgId } });
});

const makeGroup = (name: string, members: string[] = [], leadId?: string) =>
  prisma.group.create({
    data: {
      organizationId: orgId,
      name,
      leadId: leadId ?? null,
      members: { create: members.map((userId) => ({ userId })) },
    },
    select: { id: true },
  });

async function makeJob(groupId: string | null, status = "SCHEDULED") {
  return prisma.job.create({
    data: {
      organizationId: orgId,
      number: `JOB-${randomUUID().slice(0, 8)}`,
      title: "Test job",
      status,
      groupId,
    },
    select: { id: true, groupId: true },
  });
}

describe("membership", () => {
  it("lets one person belong to more than one group", async () => {
    const north = await makeGroup("Northside", [alice]);
    const office = await makeGroup("Front office", [alice, bob]);

    // Somebody who covers a territory and also does the quoting is normal, and
    // a model that forbids it would be describing an org chart, not the work.
    const memberships = await prisma.groupMember.findMany({
      where: { userId: alice },
      select: { groupId: true },
    });

    expect(memberships.map((m) => m.groupId).sort()).toEqual(
      [north.id, office.id].sort(),
    );
  });

  it("refuses to add the same person twice", async () => {
    const group = await makeGroup("Northside", [alice]);

    // Without the unique index a double-submit silently doubles the roster and
    // every headcount on the group is then wrong.
    await expect(
      prisma.groupMember.create({ data: { groupId: group.id, userId: alice } }),
    ).rejects.toThrow();
  });

  it("removes somebody from their groups when their account is deleted", async () => {
    const leaver = await makeUser(orgId, "Leaver");
    const group = await makeGroup("Northside", [alice, leaver]);

    await prisma.user.delete({ where: { id: leaver } });

    const left = await prisma.groupMember.findMany({
      where: { groupId: group.id },
      select: { userId: true },
    });
    expect(left.map((row) => row.userId)).toEqual([alice]);
  });

  it("keeps the group when its lead's account is deleted", async () => {
    const boss = await makeUser(orgId, "Boss");
    const group = await makeGroup("Northside", [alice, boss], boss);

    await prisma.user.delete({ where: { id: boss } });

    // Losing a person must never take the group and everyone else in it with
    // them — the lead is a pointer, not the thing itself.
    const after = await prisma.group.findUnique({
      where: { id: group.id },
      select: { leadId: true, _count: { select: { members: true } } },
    });
    expect(after).not.toBeNull();
    expect(after!.leadId).toBeNull();
    expect(after!._count.members).toBe(1);
  });
});

describe("names", () => {
  it("refuses two groups with the same name in one business", async () => {
    await makeGroup("Northside");

    // Two groups called Northside on a dispatch screen is a coin toss.
    await expect(makeGroup("Northside")).rejects.toThrow();
  });

  it("lets a different business use the same name", async () => {
    await makeGroup("Northside");

    const theirs = await prisma.group.create({
      data: { organizationId: otherOrgId, name: "Northside" },
      select: { id: true },
    });

    expect(theirs.id).toBeTruthy();
    await prisma.group.delete({ where: { id: theirs.id } });
  });
});

describe("jobs and history", () => {
  it("keeps a job's group when the group is retired", async () => {
    const group = await makeGroup("Northside", [alice]);
    const job = await makeJob(group.id, "COMPLETED");

    await prisma.group.update({
      where: { id: group.id },
      data: { isActive: false },
    });

    // Retiring is how a group stops being offered. Work already done under its
    // name has to keep saying so, or last quarter's reports change themselves.
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.groupId).toBe(group.id);
  });

  it("leaves the job standing when a group is deleted outright", async () => {
    const group = await makeGroup("Temporary", [alice]);
    const job = await makeJob(group.id);

    await prisma.group.delete({ where: { id: group.id } });

    // SetNull, not Cascade. Deleting a grouping must never delete the work.
    const after = await prisma.job.findUnique({ where: { id: job.id } });
    expect(after).not.toBeNull();
    expect(after!.groupId).toBeNull();
  });

  it("finds a group's jobs without walking through its members", async () => {
    const group = await makeGroup("Northside", [alice]);
    await makeJob(group.id);
    await makeJob(group.id);
    await makeJob(null);

    // The group on the job is the record of who was answerable. Deriving it
    // from current membership instead would rewrite the past every time
    // somebody moved team.
    const count = await prisma.job.count({
      where: { organizationId: orgId, groupId: group.id },
    });
    expect(count).toBe(2);
  });

  it("survives losing every member without losing its jobs", async () => {
    const temp = await makeUser(orgId, "Seasonal");
    const group = await makeGroup("Seasonal crew", [temp]);
    const job = await makeJob(group.id, "COMPLETED");

    await prisma.user.delete({ where: { id: temp } });

    const after = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
      select: { group: { select: { name: true } } },
    });
    expect(after.group?.name).toBe("Seasonal crew");
  });
});

describe("keeping one business out of another", () => {
  it("drops ids belonging to someone else's staff", async () => {
    const kept = await realMemberIds(orgId, [alice, outsider, bob]);

    // The ids come from a form, so they are input, not fact. Without this an
    // edited page could pull a stranger into a group and from there onto a
    // job, a schedule and a timesheet.
    expect(kept.sort()).toEqual([alice, bob].sort());
  });

  it("drops ids that are simply made up", async () => {
    expect(await realMemberIds(orgId, ["not-a-real-id", alice])).toEqual([alice]);
  });

  it("counts a person once however many times they were submitted", async () => {
    // A duplicated hidden input must not try to insert the same membership
    // twice, which the unique index would reject outright. The lookup already
    // collapses repeats, so this pins the contract rather than a line of code.
    expect(await realMemberIds(orgId, [alice, alice, alice])).toEqual([alice]);
  });

  it("ignores blanks rather than querying for them", async () => {
    expect(await realMemberIds(orgId, ["", "  ".trim()])).toEqual([]);
  });
});

describe("who leads", () => {
  it("keeps a lead who is in the group", () => {
    expect(leadOf("priya", ["tom", "priya"])).toBe("priya");
  });

  it("drops a lead who is not a member", () => {
    // Otherwise the group page names somebody who is not on it, and taking the
    // last person out leaves a group led by an outsider.
    expect(leadOf("priya", ["tom"])).toBeNull();
  });

  it("accepts having no lead at all", () => {
    expect(leadOf(null, ["tom"])).toBeNull();
    expect(leadOf("", ["tom"])).toBeNull();
    expect(leadOf(undefined, [])).toBeNull();
  });
});

describe("what can be assigned work", () => {
  it("offers active groups with their people", async () => {
    const group = await makeGroup("Northside", [alice, bob]);

    const offered = await assignableGroups(orgId);
    const found = offered.find((entry) => entry.id === group.id);

    expect(found?.name).toBe("Northside");
    expect(found?.memberIds.sort()).toEqual([alice, bob].sort());
  });

  it("stops offering a group once it is retired", async () => {
    const group = await makeGroup("Old route", [alice]);
    await prisma.group.update({
      where: { id: group.id },
      data: { isActive: false },
    });

    // Retiring exists precisely so nobody schedules new work to it.
    const offered = await assignableGroups(orgId);
    expect(offered.some((entry) => entry.id === group.id)).toBe(false);
  });

  it("leaves deactivated people out of the group it offers", async () => {
    const gone = await makeUser(orgId, "Departed");
    const group = await makeGroup("Northside", [alice, gone]);
    await prisma.user.update({ where: { id: gone }, data: { isActive: false } });

    // Picking the group on a job fills in its members. A deactivated account
    // cannot be assigned anywhere else, and must not sneak in through here.
    const offered = await assignableGroups(orgId);
    const found = offered.find((entry) => entry.id === group.id);
    expect(found?.memberIds).toEqual([alice]);
  });

  it("shows nothing from another business", async () => {
    await prisma.group.create({
      data: { organizationId: otherOrgId, name: "Theirs" },
    });

    const offered = await assignableGroups(orgId);
    expect(offered.some((entry) => entry.name === "Theirs")).toBe(false);
  });
});

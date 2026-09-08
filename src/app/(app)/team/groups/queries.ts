import "server-only";

import { notFound } from "next/navigation";
import { endOfWeek, startOfWeek } from "date-fns";

import { prisma } from "@/lib/db";

/**
 * Groups are a saved set of people, not an org chart.
 *
 * The counts here are what makes the list worth looking at — a group with no
 * members and no work is a group somebody made and forgot, and it should be
 * obvious at a glance which ones those are.
 */
export async function listGroups(organizationId: string) {
  const groups = await prisma.group.findMany({
    where: { organizationId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      isActive: true,
      lead: { select: { id: true, name: true } },
      _count: { select: { members: true } },
    },
  });

  if (groups.length === 0) return [];

  const now = new Date();
  const ids = groups.map((group) => group.id);

  // One grouped query rather than one per row.
  const [open, thisWeek] = await Promise.all([
    prisma.job.groupBy({
      by: ["groupId"],
      where: {
        organizationId,
        groupId: { in: ids },
        status: { in: ["SCHEDULED", "CONFIRMED", "IN_PROGRESS"] },
      },
      _count: true,
    }),
    prisma.job.groupBy({
      by: ["groupId"],
      where: {
        organizationId,
        groupId: { in: ids },
        scheduledStart: { gte: startOfWeek(now), lte: endOfWeek(now) },
      },
      _count: true,
    }),
  ]);

  const openByGroup = new Map(open.map((row) => [row.groupId, row._count]));
  const weekByGroup = new Map(thisWeek.map((row) => [row.groupId, row._count]));

  return groups.map((group) => ({
    ...group,
    openJobs: openByGroup.get(group.id) ?? 0,
    jobsThisWeek: weekByGroup.get(group.id) ?? 0,
  }));
}

export type GroupRow = Awaited<ReturnType<typeof listGroups>>[number];

export async function getGroup(organizationId: string, id: string) {
  const group = await prisma.group.findFirst({
    where: { id, organizationId },
    select: {
      id: true,
      name: true,
      description: true,
      isActive: true,
      createdAt: true,
      leadId: true,
      lead: { select: { id: true, name: true, email: true, position: true } },
      members: {
        orderBy: { user: { name: "asc" } },
        select: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              position: true,
              role: true,
              isActive: true,
            },
          },
        },
      },
    },
  });

  if (!group) notFound();
  return group;
}

export type GroupDetail = Awaited<ReturnType<typeof getGroup>>;

/** Upcoming work carrying this group's name, for the group's own page. */
export async function groupWorkload(organizationId: string, groupId: string) {
  const now = new Date();

  const [upcoming, thisWeek, completed] = await Promise.all([
    prisma.job.findMany({
      where: {
        organizationId,
        groupId,
        status: { in: ["SCHEDULED", "CONFIRMED", "IN_PROGRESS"] },
      },
      orderBy: { scheduledStart: "asc" },
      take: 8,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        scheduledStart: true,
        client: { select: { id: true, displayName: true } },
      },
    }),
    prisma.job.count({
      where: {
        organizationId,
        groupId,
        scheduledStart: { gte: startOfWeek(now), lte: endOfWeek(now) },
      },
    }),
    prisma.job.count({
      where: { organizationId, groupId, status: "COMPLETED" },
    }),
  ]);

  return { upcoming, thisWeek, completed };
}

/**
 * Groups a job can be handed to, with their members.
 *
 * The member ids travel with each group so picking one on the job form can
 * tick the right people without another round trip.
 */
export async function assignableGroups(organizationId: string) {
  const groups = await prisma.group.findMany({
    where: { organizationId, isActive: true },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      members: {
        where: { user: { isActive: true } },
        select: { userId: true },
      },
    },
  });

  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    memberIds: group.members.map((member) => member.userId),
  }));
}

export type AssignableGroup = Awaited<
  ReturnType<typeof assignableGroups>
>[number];

/**
 * Narrows submitted member ids to people who really are in this business.
 *
 * The ids arrive from a form, so they are input, not fact. Without this an
 * edited page could pull somebody from another company into a group — and
 * from there onto a job, a schedule and a timesheet.
 */
export async function realMemberIds(organizationId: string, ids: string[]) {
  const wanted = ids.filter(Boolean);
  if (wanted.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { organizationId, id: { in: wanted } },
    select: { id: true },
  });

  return users.map((user) => user.id);
}

/**
 * The lead to store for a group, given who ended up in it.
 *
 * A lead who is not a member is a job title with nobody attached: the group
 * page would name somebody who is not on it, and removing the last member
 * would leave a group led by an outsider.
 */
export function leadOf(leadId: string | null | undefined, members: string[]) {
  if (!leadId) return null;
  return members.includes(leadId) ? leadId : null;
}

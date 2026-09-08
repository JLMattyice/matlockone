import "server-only";

import { notFound } from "next/navigation";
import { endOfWeek, startOfMonth, startOfWeek } from "date-fns";

import { prisma } from "@/lib/db";

export async function listTeam(organizationId: string, includeInactive = true) {
  const members = await prisma.user.findMany({
    where: {
      organizationId,
      ...(includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      position: true,
      hourlyRateCents: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
      _count: { select: { assignments: true } },
    },
  });

  const ids = members.map((m) => m.id);
  const now = new Date();

  // Open work per person, in one grouped query rather than one per row.
  const [openJobs, weekJobs] = await Promise.all([
    ids.length
      ? prisma.jobAssignment.groupBy({
          by: ["userId"],
          where: {
            userId: { in: ids },
            job: {
              organizationId,
              status: { in: ["SCHEDULED", "CONFIRMED", "IN_PROGRESS"] },
            },
          },
          _count: true,
        })
      : [],
    ids.length
      ? prisma.jobAssignment.groupBy({
          by: ["userId"],
          where: {
            userId: { in: ids },
            job: {
              organizationId,
              scheduledStart: {
                gte: startOfWeek(now),
                lte: endOfWeek(now),
              },
            },
          },
          _count: true,
        })
      : [],
  ]);

  const openByUser = new Map(openJobs.map((r) => [r.userId, r._count]));
  const weekByUser = new Map(weekJobs.map((r) => [r.userId, r._count]));

  return members.map((member) => ({
    ...member,
    openJobs: openByUser.get(member.id) ?? 0,
    jobsThisWeek: weekByUser.get(member.id) ?? 0,
  }));
}

export type TeamMemberRow = Awaited<ReturnType<typeof listTeam>>[number];

export async function getTeamMember(organizationId: string, id: string) {
  const member = await prisma.user.findFirst({
    where: { id, organizationId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      position: true,
      hourlyRateCents: true,
      avatarUrl: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  if (!member) notFound();
  return member;
}

export type TeamMember = Awaited<ReturnType<typeof getTeamMember>>;

/** Upcoming work, recent history and month-to-date hours for one person. */
export async function memberWorkload(organizationId: string, userId: string) {
  const now = new Date();

  const [upcoming, recent, hours, completedCount] = await Promise.all([
    prisma.job.findMany({
      where: {
        organizationId,
        assignments: { some: { userId } },
        status: { in: ["SCHEDULED", "CONFIRMED", "IN_PROGRESS"] },
        scheduledStart: { gte: startOfWeek(now) },
      },
      orderBy: { scheduledStart: "asc" },
      take: 8,
      include: {
        client: { select: { id: true, displayName: true } },
        address: { select: { line1: true, city: true } },
      },
    }),

    prisma.job.findMany({
      where: {
        organizationId,
        assignments: { some: { userId } },
        status: "COMPLETED",
      },
      orderBy: { completedAt: "desc" },
      take: 8,
      include: { client: { select: { id: true, displayName: true } } },
    }),

    prisma.timeEntry.aggregate({
      where: {
        organizationId,
        userId,
        startedAt: { gte: startOfMonth(now) },
      },
      _sum: { minutes: true },
    }),

    prisma.jobAssignment.count({
      where: { userId, job: { organizationId, status: "COMPLETED" } },
    }),
  ]);

  return {
    upcoming,
    recent,
    minutesThisMonth: hours._sum.minutes ?? 0,
    completedCount,
  };
}

/** Guards role changes: an organization must keep at least one active owner. */
export async function activeOwnerCount(organizationId: string) {
  return prisma.user.count({
    where: { organizationId, role: "OWNER", isActive: true },
  });
}

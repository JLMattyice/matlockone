import "server-only";

import { prisma } from "@/lib/db";

/**
 * Every business that has signed up, across the whole of Matlock One — for
 * the operator only (see src/lib/operator.ts). The shared demo is left out:
 * nobody signed up for it.
 */
export async function allBusinesses() {
  return prisma.organization.findMany({
    where: { isDemo: false },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      businessType: true,
      createdAt: true,
      isDemo: true,
      billingExempt: true,
      licenseKey: true,
      subscriptionStatus: true,
      subscriptionPlan: true,
      subscriptionInterval: true,
      paidThrough: true,
      users: {
        orderBy: { createdAt: "asc" },
        select: { name: true, email: true, role: true, isActive: true, lastLoginAt: true },
      },
    },
  });
}

export type BusinessRow = Awaited<ReturnType<typeof allBusinesses>>[number];

/** The people who most recently made an account, in any business. */
export async function newestPeople(take = 50) {
  return prisma.user.findMany({
    where: { organization: { isDemo: false } },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      createdAt: true,
      lastLoginAt: true,
      organization: { select: { name: true } },
    },
  });
}

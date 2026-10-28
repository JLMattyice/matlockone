import "server-only";

import { prisma } from "@/lib/db";
import { CHECKOUT_ACTION, DEMO_ACTION, type FunnelFields } from "@/lib/signup-funnel";

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
      trialEndsAt: true,
      trialCode: { select: { code: true } },
      users: {
        orderBy: { createdAt: "asc" },
        select: { name: true, email: true, role: true, isActive: true, lastLoginAt: true },
      },
    },
  });
}

export type BusinessRow = Awaited<ReturnType<typeof allBusinesses>>[number];

/**
 * What the sign-up funnel needs (see src/lib/signup-funnel.ts): how far each
 * business got, when each first left for PayPal, and every demo sign-in.
 */
export async function signupFunnel() {
  const [orgs, checkouts, demo] = await Promise.all([
    prisma.organization.findMany({
      where: { isDemo: false },
      select: {
        id: true,
        createdAt: true,
        billingExempt: true,
        licenseKey: true,
        paidThrough: true,
        trialEndsAt: true,
        _count: { select: { clients: true, jobs: true, estimates: true, invoices: true } },
      },
    }),
    prisma.auditLog.findMany({
      where: { action: CHECKOUT_ACTION },
      orderBy: { createdAt: "asc" },
      select: { organizationId: true, createdAt: true },
    }),
    prisma.auditLog.findMany({ where: { action: DEMO_ACTION }, select: { createdAt: true } }),
  ]);

  const wentToPayPal = new Map<string, Date>();
  for (const row of checkouts) {
    if (!wentToPayPal.has(row.organizationId)) wentToPayPal.set(row.organizationId, row.createdAt);
  }

  const businesses: FunnelFields[] = orgs.map(({ _count, ...org }) => ({
    ...org,
    wentToPayPalAt: wentToPayPal.get(org.id) ?? null,
    records: _count.clients + _count.jobs + _count.estimates + _count.invoices,
  }));

  return { businesses, wentToPayPal, demoSignIns: demo.map((row) => row.createdAt) };
}

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

/**
 * Every free-month code, newest first, with the businesses that entered each
 * — the demo never among them, since it cannot enter one.
 */
export async function allTrialCodes() {
  return prisma.trialCode.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      code: true,
      note: true,
      maxUses: true,
      expiresAt: true,
      disabledAt: true,
      createdAt: true,
      organizations: {
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true },
      },
    },
  });
}

export type TrialCodeRow = Awaited<ReturnType<typeof allTrialCodes>>[number];

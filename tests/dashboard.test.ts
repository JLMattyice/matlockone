import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadDashboard } from "@/app/(app)/dashboard/queries";
import type { AppContext, SessionUser } from "@/lib/auth";
import type { Role } from "@/lib/constants";
import { prisma } from "@/lib/db";
import type { Organization } from "@/generated/prisma/client";

/**
 * The dashboard is the one screen everybody opens, so the figures on it have
 * to be both right and role-aware. What is pinned here is that spend is
 * scoped to this month and this business, that money owed to a teammate is
 * deliberately *not* scoped to the month, and that a role without the
 * expenses permission gets nothing fetched rather than something hidden.
 */

let org: Organization;
let otherOrg: Organization;
let payer: { id: string };

const dayInMonth = (day: number) => {
  const date = new Date();
  date.setDate(1);
  date.setHours(12, 0, 0, 0);
  date.setDate(day);
  return date;
};

const monthsBack = (months: number) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  // Mid-month before stepping back, or setMonth rolls a 31st into the next
  // month whenever the target month is shorter — which would land the row in
  // the wrong bucket on three days out of thirty.
  date.setDate(15);
  date.setMonth(date.getMonth() - months);
  return date;
};

function contextFor(role: Role, organization: Organization): AppContext {
  const user: SessionUser = {
    id: payer.id,
    organizationId: organization.id,
    email: "dash@example.com",
    name: "Dash Tester",
    phone: null,
    avatarUrl: null,
    role,
    position: null,
  };
  return { user, org: organization };
}

beforeEach(async () => {
  org = await prisma.organization.create({
    data: { slug: `dash-${randomUUID()}`, name: "Dashboard Test Co" },
  });
  otherOrg = await prisma.organization.create({
    data: { slug: `dash-${randomUUID()}`, name: "Someone Else Ltd" },
  });

  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `dash-${randomUUID()}@example.com`,
      passwordHash: "x",
      name: "Dash Tester",
      role: "OWNER",
    },
  });
  payer = { id: user.id };

  await prisma.expense.createMany({
    data: [
      // This month.
      {
        organizationId: org.id,
        description: "Conduit and fittings",
        category: "MATERIALS",
        amountCents: 30_000,
        spentAt: dayInMonth(2),
      },
      {
        organizationId: org.id,
        description: "Diesel",
        category: "FUEL",
        amountCents: 5_000,
        spentAt: dayInMonth(3),
        reimbursable: true,
        paidById: user.id,
      },
      // Four months ago, still unsettled.
      {
        organizationId: org.id,
        description: "Parking on site",
        category: "TRAVEL",
        amountCents: 2_000,
        spentAt: monthsBack(4),
        reimbursable: true,
        paidById: user.id,
      },
      // Already paid back, so it is not owed.
      {
        organizationId: org.id,
        description: "Coffee run",
        category: "MEALS",
        amountCents: 1_200,
        spentAt: dayInMonth(4),
        reimbursable: true,
        reimbursedAt: dayInMonth(5),
        paidById: user.id,
      },
      // Another business entirely.
      {
        organizationId: otherOrg.id,
        description: "Not our money",
        category: "MATERIALS",
        amountCents: 900_000,
        spentAt: dayInMonth(2),
        reimbursable: true,
      },
    ],
  });
});

afterEach(async () => {
  await prisma.organization.deleteMany({
    where: { id: { in: [org.id, otherOrg.id] } },
  });
});

describe("loadDashboard", () => {
  it("totals this month's spend for this business only", async () => {
    const data = await loadDashboard(contextFor("OWNER", org));

    expect(data.seesExpenses).toBe(true);
    // 30,000 + 5,000 + 1,200 — the four-month-old expense is out of the month.
    expect(data.spentThisMonthCents).toBe(36_200);
    expect(data.spentThisMonthCount).toBe(3);
  });

  it("counts money owed back regardless of when it was spent", async () => {
    const data = await loadDashboard(contextFor("OWNER", org));

    // Diesel this month plus parking from four months ago. The coffee run is
    // settled and the other business's expense is not ours.
    expect(data.reimbursementsOwedCents).toBe(7_000);
    expect(data.reimbursementsOwedCount).toBe(2);

    // Oldest first: the debt that has been outstanding longest leads.
    expect(data.reimbursementsOwed[0].description).toBe("Parking on site");
    expect(data.reimbursementsOwed.map((e) => e.description)).not.toContain(
      "Coffee run",
    );
  });

  it("fetches no spend at all for a role without the permission", async () => {
    const data = await loadDashboard(contextFor("EMPLOYEE", org));

    expect(data.seesExpenses).toBe(false);
    expect(data.spentThisMonthCents).toBe(0);
    expect(data.spentThisMonthCount).toBe(0);
    expect(data.reimbursementsOwed).toEqual([]);
    expect(data.reimbursementsOwedCents).toBe(0);

    // The chart is built from the same rows, so it has to be empty too —
    // otherwise the figures would reach the page and rely on it to hide them.
    expect(data.monthlyCashFlow.every((b) => b.outCents === 0)).toBe(true);
  });

  it("buckets money in and out onto the same six months", async () => {
    const client = await prisma.client.create({
      data: { organizationId: org.id, displayName: "Payer", type: "PERSON" },
    });
    const invoice = await prisma.invoice.create({
      data: {
        organizationId: org.id,
        clientId: client.id,
        number: `INV-${Date.now()}`,
        status: "PAID",
        totalCents: 50_000,
      },
    });
    await prisma.payment.create({
      data: {
        organizationId: org.id,
        invoiceId: invoice.id,
        amountCents: 50_000,
        receivedAt: dayInMonth(2),
      },
    });

    const data = await loadDashboard(contextFor("OWNER", org));

    expect(data.monthlyCashFlow).toHaveLength(6);

    const thisMonth = data.monthlyCashFlow[5];
    expect(thisMonth.inCents).toBe(50_000);
    expect(thisMonth.outCents).toBe(36_200);

    // The four-month-old expense lands in its own bucket, not this one.
    expect(data.monthlyCashFlow[1].outCents).toBe(2_000);
  });
});

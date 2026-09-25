import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/cron/automations/route";
import { prisma } from "@/lib/db";
import { sweepEveryBusiness } from "@/lib/workflows/run";

/**
 * The morning run.
 *
 * What matters is who can start it and what it touches. Vercel is the only
 * caller that should get through; every business with a date-based automation
 * should be swept, and nobody else's; and a second run on the same morning
 * must raise nothing, since Vercel does not promise to call exactly once.
 *
 * The test database is shared across files, so every assertion here is about
 * the businesses this file made rather than totals across all of them.
 */

const SECRET = "s".repeat(32);

const daysAgo = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
};

/** A business with a customer who owes on an invoice two weeks past due. */
async function businessWithOverdueInvoice(name: string) {
  const org = await prisma.organization.create({
    data: { slug: `cron-${randomUUID()}`, name },
  });
  const client = await prisma.client.create({
    data: { organizationId: org.id, displayName: `${name} Customer`, type: "PERSON", status: "ACTIVE" },
  });
  await prisma.invoice.create({
    data: {
      organizationId: org.id,
      clientId: client.id,
      number: `INV-${Math.floor(Math.random() * 100_000)}`,
      status: "SENT",
      issueDate: daysAgo(30),
      dueDate: daysAgo(14),
      subtotalCents: 20_000,
      totalCents: 20_000,
      balanceCents: 20_000,
    },
  });
  return org.id;
}

const turnOn = (organizationId: string, templateId: string, isActive = true) =>
  prisma.workflow.create({
    data: { organizationId, templateId, isActive, config: JSON.stringify({ days: 7, dueInDays: 1 }) },
  });

const tasksFor = (organizationId: string) =>
  prisma.task.findMany({ where: { organizationId }, select: { title: true } });

const call = (authorization?: string) =>
  GET(
    new Request("https://www.matlockone.com/api/cron/automations", {
      headers: authorization ? { authorization } : {},
    }),
  );

let chasing: string;

beforeEach(async () => {
  chasing = await businessWithOverdueInvoice("Chasing Co");
  await turnOn(chasing, "overdue.chase");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sweepEveryBusiness", () => {
  it("sweeps each business that has a date-based automation on", async () => {
    const second = await businessWithOverdueInvoice("Also Chasing Ltd");
    await turnOn(second, "overdue.chase");

    const result = await sweepEveryBusiness();

    expect(result.failed).toEqual([]);
    expect(await tasksFor(chasing)).toHaveLength(1);
    expect(await tasksFor(second)).toHaveLength(1);
  });

  it("leaves alone a business whose automation is switched off", async () => {
    const off = await businessWithOverdueInvoice("Switched Off Inc");
    await turnOn(off, "overdue.chase", false);

    await sweepEveryBusiness();

    expect(await tasksFor(off)).toHaveLength(0);
  });

  it("leaves alone a business with only event automations", async () => {
    // Thanking a customer for paying fires when the payment is recorded. The
    // morning run has nothing to add to it, and must not sweep for it.
    const events = await businessWithOverdueInvoice("Events Only Co");
    await turnOn(events, "paid.thank");

    await sweepEveryBusiness();

    expect(await tasksFor(events)).toHaveLength(0);
  });
});

describe("the morning route", () => {
  it("is refused on a deployment with no secret", async () => {
    vi.stubEnv("CRON_SECRET", "");

    const response = await call(`Bearer ${SECRET}`);

    // Refused outright rather than run open: an address anybody could call to
    // make the database walk every business is a way to slow it for everyone.
    expect(response.status).toBe(503);
    expect(await tasksFor(chasing)).toHaveLength(0);
  });

  it("is refused on a deployment whose secret is too short to be one", async () => {
    vi.stubEnv("CRON_SECRET", "short");

    expect((await call("Bearer short")).status).toBe(503);
  });

  it("is refused without the secret, or with the wrong one", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);

    for (const authorization of [undefined, SECRET, `Bearer ${"x".repeat(32)}`, `Bearer ${SECRET}x`]) {
      expect((await call(authorization)).status, String(authorization)).toBe(401);
    }
    expect(await tasksFor(chasing)).toHaveLength(0);
  });

  it("runs the sweep for Vercel's call, and raises nothing the second time", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);

    const first = await call(`Bearer ${SECRET}`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ failed: [] });

    const second = await call(`Bearer ${SECRET}`);
    expect(second.status).toBe(200);

    const tasks = await tasksFor(chasing);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toMatch(/^Chase Chasing Co Customer about INV-/);
  });
});

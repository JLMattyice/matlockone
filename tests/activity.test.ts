import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  activityHref,
  canSeeBusinessActivity,
  clientTimeline,
  hiddenActions,
  groupByDay,
  jobTimeline,
  record,
  recentActivity,
  type ActivityEvent,
} from "@/lib/activity";
import { prisma } from "@/lib/db";

/**
 * The activity timeline.
 *
 * Two things carry the feature: that a client's timeline gathers events from
 * their work and documents rather than only from the client row, and that
 * recording can never take down the thing it is describing.
 */

/** The two viewers the permission split is about. */
const OWNER = { role: "OWNER" as const };
const TECH = { role: "EMPLOYEE" as const };

let organizationId: string;
let otherOrganizationId: string;
let clientId: string;
let userId: string;

async function seedOrg(name: string) {
  const org = await prisma.organization.create({
    data: { slug: `activity-${randomUUID()}`, name },
  });
  return org.id;
}

beforeEach(async () => {
  organizationId = await seedOrg("Activity Test Co");
  otherOrganizationId = await seedOrg("Someone Else Ltd");

  const user = await prisma.user.create({
    data: {
      organizationId,
      email: `alex-${randomUUID()}@example.test`,
      name: "Alex Rivera",
      passwordHash: "x",
      role: "OWNER",
    },
  });
  userId = user.id;

  const client = await prisma.client.create({
    data: { organizationId, displayName: "Oscar Nakamura", type: "PERSON" },
  });
  clientId = client.id;
});

describe("record", () => {
  it("stores the sentence as it was written", async () => {
    await record({
      organizationId,
      userId,
      action: "client.created",
      entityType: "CLIENT",
      entityId: clientId,
      summary: "Client Oscar Nakamura added",
    });

    const [event] = await clientTimeline(organizationId, clientId, OWNER);

    expect(event.summary).toBe("Client Oscar Nakamura added");
    expect(event.actor).toBe("Alex Rivera");
  });

  it("keeps the wording even after the record is renamed", async () => {
    // Rebuilding the sentence from joins at read time would mean a renamed
    // client silently rewrites history.
    await record({
      organizationId,
      userId,
      action: "client.created",
      entityType: "CLIENT",
      entityId: clientId,
      summary: "Client Oscar Nakamura added",
    });

    await prisma.client.update({
      where: { id: clientId },
      data: { displayName: "Oscar N. Holdings" },
    });

    const [event] = await clientTimeline(organizationId, clientId, OWNER);
    expect(event.summary).toBe("Client Oscar Nakamura added");
  });

  it("never throws, whatever it is handed", async () => {
    // An invoice that sent successfully must not report an error because its
    // activity row could not be written.
    await expect(
      record({
        organizationId: "no-such-organization",
        action: "invoice.sent",
        entityType: "INVOICE",
        entityId: "nope",
        summary: "Invoice sent",
      }),
    ).resolves.toBeUndefined();
  });

  it("survives losing the person who did it", async () => {
    await record({
      organizationId,
      userId,
      action: "job.created",
      entityType: "CLIENT",
      entityId: clientId,
      summary: "Job created — Ductwork cleaning",
    });

    // A departed employee is deleted; the history they made stays.
    await prisma.user.delete({ where: { id: userId } });

    const [event] = await clientTimeline(organizationId, clientId, OWNER);
    expect(event.summary).toBe("Job created — Ductwork cleaning");
    expect(event.actor).toBeNull();
  });
});

describe("clientTimeline", () => {
  it("gathers events from the client's work and documents, not just the client", async () => {
    const job = await prisma.job.create({
      data: {
        organizationId,
        clientId,
        number: "JOB-1",
        title: "Ductwork cleaning",
      },
    });

    const invoice = await prisma.invoice.create({
      data: {
        organizationId,
        clientId,
        number: "INV-1",
        status: "SENT",
        issueDate: new Date(),
        subtotalCents: 1000,
        totalCents: 1000,
        balanceCents: 1000,
      },
    });

    await record({
      organizationId,
      userId,
      action: "client.created",
      entityType: "CLIENT",
      entityId: clientId,
      summary: "Client added",
    });
    await record({
      organizationId,
      userId,
      action: "job.created",
      entityType: "JOB",
      entityId: job.id,
      summary: "Job created",
    });
    await record({
      organizationId,
      userId,
      action: "invoice.sent",
      entityType: "INVOICE",
      entityId: invoice.id,
      summary: "Invoice sent",
    });

    const events = await clientTimeline(organizationId, clientId, OWNER);

    // All three, which is the whole reason somebody opens this tab.
    expect(events.map((e) => e.summary).sort()).toEqual([
      "Client added",
      "Invoice sent",
      "Job created",
    ]);
  });

  it("puts the newest first", async () => {
    await record({
      organizationId,
      userId,
      action: "client.created",
      entityType: "CLIENT",
      entityId: clientId,
      summary: "First",
    });
    await record({
      organizationId,
      userId,
      action: "note.added",
      entityType: "CLIENT",
      entityId: clientId,
      summary: "Second",
    });

    const events = await clientTimeline(organizationId, clientId, OWNER);
    expect(events[0].summary).toBe("Second");
  });

  it("never shows another business's events", async () => {
    // The id of a job belonging to someone else must not pull their history
    // into this timeline.
    await record({
      organizationId: otherOrganizationId,
      action: "invoice.sent",
      entityType: "CLIENT",
      entityId: clientId,
      summary: "Their invoice",
    });

    const events = await clientTimeline(organizationId, clientId, OWNER);
    expect(events).toHaveLength(0);
  });
});

describe("jobTimeline", () => {
  it("covers one job only", async () => {
    const job = await prisma.job.create({
      data: { organizationId, clientId, number: "JOB-2", title: "Panel upgrade" },
    });

    await record({
      organizationId,
      userId,
      action: "job.status",
      entityType: "JOB",
      entityId: job.id,
      summary: "Job marked in progress",
    });
    await record({
      organizationId,
      userId,
      action: "client.created",
      entityType: "CLIENT",
      entityId: clientId,
      summary: "Client added",
    });

    const events = await jobTimeline(organizationId, job.id, OWNER);
    expect(events.map((e) => e.summary)).toEqual(["Job marked in progress"]);
  });
});

describe("recentActivity", () => {
  it("reads the whole workspace, newest first", async () => {
    for (const summary of ["One", "Two", "Three"]) {
      await record({
        organizationId,
        userId,
        action: "note.added",
        entityType: "CLIENT",
        entityId: clientId,
        summary,
      });
    }

    const events = await recentActivity(organizationId, OWNER, 2);
    expect(events).toHaveLength(2);
    expect(events[0].summary).toBe("Three");
  });
});

describe("groupByDay", () => {
  const event = (id: string, createdAt: Date): ActivityEvent => ({
    id,
    action: "note.added",
    entityType: "CLIENT",
    entityId: "c1",
    summary: id,
    createdAt,
    actor: null,
  });

  it("names today and yesterday rather than dating them", () => {
    const now = new Date(2026, 8, 20, 14, 0);
    const yesterday = new Date(2026, 8, 19, 9, 0);

    const groups = groupByDay([event("a", now), event("b", yesterday)], now);

    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
  });

  it("keeps several events from one day together", () => {
    const now = new Date(2026, 8, 20, 14, 0);
    const earlier = new Date(2026, 8, 20, 9, 0);

    const groups = groupByDay([event("a", now), event("b", earlier)], now);

    expect(groups).toHaveLength(1);
    expect(groups[0].events).toHaveLength(2);
  });

  it("dates anything older, and names the year only when it is not this one", () => {
    const now = new Date(2026, 8, 20, 14, 0);
    const lastMonth = new Date(2026, 7, 3, 9, 0);
    const lastYear = new Date(2025, 7, 3, 9, 0);

    const groups = groupByDay([event("a", lastMonth), event("b", lastYear)], now);

    expect(groups[0].label).toContain("Aug");
    expect(groups[0].label).not.toContain("2026");
    expect(groups[1].label).toContain("2025");
  });
});

describe("activityHref", () => {
  it("points each kind at its own page", () => {
    expect(activityHref("JOB", "j1")).toBe("/jobs/j1");
    expect(activityHref("INVOICE", "i1")).toBe("/invoices/i1");
    expect(activityHref("CLIENT", "c1")).toBe("/clients/c1");
  });

  it("has nowhere to send a payment, which is read on its invoice", () => {
    expect(activityHref("PAYMENT", "p1")).toBeNull();
  });
});


describe("who may read the timeline", () => {
  /**
   * The timeline is written in plain sentences, and those sentences carry what
   * the screens underneath are careful to hide. This shipped first without the
   * check: any employee could open a client and read their payment history as
   * timeline lines.
   */
  it("is for people who can see the whole business and its money", () => {
    expect(canSeeBusinessActivity(OWNER)).toBe(true);
    expect(canSeeBusinessActivity({ role: "MANAGER" })).toBe(true);
    expect(canSeeBusinessActivity(TECH)).toBe(false);
  });

  it("hides the money events from anyone without the screens they describe", () => {
    expect(hiddenActions(OWNER)).toEqual([]);
    expect(hiddenActions(TECH)).toEqual(
      expect.arrayContaining(["payment.recorded", "invoice.sent", "estimate.sent"]),
    );
  });

  it("never hands a payment line to a technician, even if a caller forgets the gate", async () => {
    await record({
      organizationId,
      userId,
      action: "payment.recorded",
      entityType: "CLIENT",
      entityId: clientId,
      summary: "$1,250.00 received against invoice INV-1042",
    });
    await record({
      organizationId,
      userId,
      action: "job.created",
      entityType: "CLIENT",
      entityId: clientId,
      summary: "Job created — Panel upgrade",
    });

    const asTech = await clientTimeline(organizationId, clientId, TECH);
    const asOwner = await clientTimeline(organizationId, clientId, OWNER);

    expect(asTech.map((e) => e.summary)).toEqual(["Job created — Panel upgrade"]);
    expect(asOwner).toHaveLength(2);

    // The same filter on the business-wide feed.
    const recentForTech = await recentActivity(organizationId, TECH, 10);
    expect(recentForTech.some((e) => e.action === "payment.recorded")).toBe(false);
  });
});

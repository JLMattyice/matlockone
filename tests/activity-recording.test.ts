import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The events that were declared and never written: notes, uploads and lead
 * conversions.
 *
 * Driven through the real server actions, signed in as a real user of a real
 * business in the test database, and read back through the real timeline
 * queries. Only the parts of Next that need a request — the session, and the
 * cache and redirects — are stood in for. What is being pinned is the wiring:
 * that doing the thing puts the right line on the right timeline, and that
 * the people who should not read a line do not get it.
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

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { uploadAttachment } from "@/app/(app)/files/actions";
import { convertLeadToClient } from "@/app/(app)/leads/actions";
import { addNote, deleteNote } from "@/app/(app)/notes/actions";
import { IDLE } from "@/lib/action-state";
import { clientTimeline, jobTimeline } from "@/lib/activity";
import { prisma } from "@/lib/db";

const OWNER = { role: "OWNER" as const };
const TECH = { role: "EMPLOYEE" as const };

let organizationId: string;
let clientId: string;
let jobId: string;
let storageDir: string;

const form = (fields: Record<string, string | File | File[]>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
};

const summaries = (events: { summary: string | null }[]) => events.map((event) => event.summary);

beforeAll(() => {
  // Uploads go to a folder of their own, not the developer's ./storage.
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-uploads-"));
  process.env.STORAGE_DIR = storageDir;
});

afterAll(() => {
  delete process.env.STORAGE_DIR;
  fs.rmSync(storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const org = await prisma.organization.create({
    data: { slug: `recording-${randomUUID()}`, name: "Recording Test Co" },
  });
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `owner-${randomUUID()}@example.test`,
      name: "Morgan Hale",
      passwordHash: "x",
      role: "OWNER",
    },
  });
  session.org = org;
  session.user = user;
  organizationId = org.id;

  const client = await prisma.client.create({
    data: { organizationId, displayName: "Priya Raman", type: "PERSON" },
  });
  clientId = client.id;

  const job = await prisma.job.create({
    data: { organizationId, clientId, number: "JOB-7", title: "Water heater swap" },
  });
  jobId = job.id;
});

describe("notes", () => {
  it("put a quoted line on the job's timeline", async () => {
    await addNote(
      IDLE,
      form({
        entityType: "job",
        entityId: jobId,
        body: "Customer wants the new tank in the garage, not the basement. Check the gas line first.",
        visibility: "INTERNAL",
      }),
    );

    expect(summaries(await jobTimeline(organizationId, jobId, OWNER))).toEqual([
      "Note — Customer wants the new tank in the garage, not the basement. Check the gas line…",
    ]);
  });

  it("take their line with them when deleted, and only theirs", async () => {
    await addNote(IDLE, form({ entityType: "job", entityId: jobId, body: "Keep this one", visibility: "INTERNAL" }));
    await addNote(IDLE, form({ entityType: "job", entityId: jobId, body: "Wrote this by mistake", visibility: "INTERNAL" }));

    const mistake = await prisma.note.findFirstOrThrow({
      where: { organizationId, body: "Wrote this by mistake" },
    });
    await deleteNote(form({ id: mistake.id, entityType: "job", entityId: jobId }));

    // A deleted note must not live on as a quotation of itself.
    expect(summaries(await jobTimeline(organizationId, jobId, OWNER))).toEqual([
      "Note — Keep this one",
    ]);
  });

  it("on the job's invoice are the invoice's business", async () => {
    const invoice = await prisma.invoice.create({
      data: {
        organizationId,
        clientId,
        jobId,
        number: "INV-7001",
        status: "SENT",
        issueDate: new Date(),
        subtotalCents: 90_000,
        totalCents: 90_000,
        balanceCents: 90_000,
      },
    });

    await addNote(IDLE, form({ entityType: "job", entityId: jobId, body: "Old tank hauled away", visibility: "INTERNAL" }));
    await addNote(
      IDLE,
      form({ entityType: "invoice", entityId: invoice.id, body: "Agreed a 10% discount if paid this week", visibility: "INTERNAL" }),
    );

    // The owner reads the job's whole story, invoice included.
    expect(summaries(await jobTimeline(organizationId, jobId, OWNER))).toEqual(
      expect.arrayContaining([
        "Note — Old tank hauled away",
        "Note — Agreed a 10% discount if paid this week",
      ]),
    );

    // The crew reads the job. A note about what the customer is paying is not
    // theirs, even though it is on this job's invoice.
    expect(summaries(await jobTimeline(organizationId, jobId, TECH))).toEqual([
      "Note — Old tank hauled away",
    ]);
  });
});

describe("converting a lead", () => {
  it("starts the new client's timeline with one line", async () => {
    const lead = await prisma.lead.create({
      data: { organizationId, name: "Dana Whitfield", source: "REFERRAL", status: "QUALIFIED" },
    });

    await expect(convertLeadToClient(form({ id: lead.id }))).rejects.toThrow(/NEXT_REDIRECT \/clients\//);

    const converted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(converted.clientId).not.toBeNull();

    // One line, not "client added" beside it saying the same thing.
    expect(summaries(await clientTimeline(organizationId, converted.clientId!, OWNER))).toEqual([
      "Won from a lead (Referral)",
    ]);
  });
});

describe("uploads", () => {
  const photo = (name: string) => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], name, { type: "image/jpeg" });

  it("put one captioned line on the timeline per batch", async () => {
    const result = await uploadAttachment(
      IDLE,
      form({
        entityType: "job",
        entityId: jobId,
        kind: "PHOTO",
        photoStage: "BEFORE",
        caption: "Before demolition",
        files: [photo("IMG_4032.jpg"), photo("IMG_4033.jpg")],
      }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(await prisma.attachment.count({ where: { organizationId, jobId } })).toBe(2);

    // One line for the visit, not one per file, and in the words a person
    // wrote rather than the names a phone gave the photos.
    expect(summaries(await jobTimeline(organizationId, jobId, OWNER))).toEqual([
      "Added 2 photos — Before demolition",
    ]);
  });

  it("write nothing when nothing was stored", async () => {
    const result = await uploadAttachment(
      IDLE,
      form({
        entityType: "job",
        entityId: jobId,
        kind: "DOCUMENT",
        files: [new File(["#!/bin/sh"], "run.sh", { type: "application/x-sh" })],
      }),
    );

    expect(result).not.toMatchObject({ ok: true });
    expect(await jobTimeline(organizationId, jobId, OWNER)).toEqual([]);
  });
});

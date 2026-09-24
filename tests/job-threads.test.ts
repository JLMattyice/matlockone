import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.SESSION_SECRET ??= "test-secret-0123456789abcdef";

const {
  conversationTitle,
  getConversation,
  jobThreadSummary,
  joinJobThread,
  listConversations,
  openDirectConversation,
  openJobThread,
  postMessage,
  threadMessages,
  unreadMessageCount,
} = await import("@/lib/conversations");
const { prisma } = await import("@/lib/db");
const { putFile, resetStorageAdapter, statFile } = await import("@/lib/storage");
const { acceptUploadTicket } = await import("@/lib/storage/accept");
const { signUploadTicket } = await import("@/lib/storage/ticket");

import type { Role } from "@/lib/constants";
import type { Viewer } from "@/lib/conversations";

/**
 * Job threads, and photos in them.
 *
 * The rule that carries it: a job's conversation belongs to the job. The
 * office can read it without being asked in, the crew on the job can read it,
 * and a technician who is not on the job cannot — even one who used to be.
 * Membership only decides whose inbox it sits in.
 *
 * Photos are job photos first. A message may carry only photos of its own
 * thread's job that its author uploaded and nobody has sent before, because
 * the ids arrive from the browser.
 */

let organizationId: string;
let otherOrganizationId: string;
let owner: string;
let office: string;
let tech: string;
let apprentice: string;
let jobId: string;
let otherJobId: string;

const roles = new Map<string, Role>();
const as = (id: string): Viewer => ({ id, role: roles.get(id) ?? "EMPLOYEE" });

async function seedOrg(name: string) {
  const org = await prisma.organization.create({
    data: { slug: `job-threads-${randomUUID()}`, name },
  });
  return org.id;
}

async function addUser(orgId: string, role: Role, name: string) {
  const user = await prisma.user.create({
    data: {
      organizationId: orgId,
      email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
      name,
      passwordHash: "x",
      role,
    },
  });
  roles.set(user.id, role);
  return user.id;
}

async function addJob(number: string, title: string, crew: string[] = []) {
  const client = await prisma.client.create({
    data: { organizationId, displayName: "Nina Castellanos", type: "PERSON" },
  });
  const job = await prisma.job.create({
    data: {
      organizationId,
      clientId: client.id,
      number,
      title,
      assignments: { create: crew.map((userId) => ({ userId })) },
    },
  });
  return job.id;
}

async function addPhoto(data: {
  jobId: string | null;
  uploadedById: string;
  kind?: string;
  organizationId?: string;
}) {
  const attachment = await prisma.attachment.create({
    data: {
      organizationId: data.organizationId ?? organizationId,
      kind: data.kind ?? "PHOTO",
      fileName: `${randomUUID()}.jpg`,
      originalName: "IMG_4411.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      storagePath: `${organizationId}/${randomUUID()}.jpg`,
      jobId: data.jobId,
      uploadedById: data.uploadedById,
    },
  });
  return attachment.id;
}

async function say(conversationId: string, authorId: string, body: string, photoIds?: string[]) {
  return postMessage({ organizationId, conversationId, author: as(authorId), body, photoIds });
}

beforeEach(async () => {
  organizationId = await seedOrg("Job Threads Co");
  otherOrganizationId = await seedOrg("Someone Else Ltd");

  owner = await addUser(organizationId, "OWNER", "Alex Rivera");
  office = await addUser(organizationId, "ADMIN", "Dana Okonkwo");
  tech = await addUser(organizationId, "EMPLOYEE", "Priya Raghavan");
  apprentice = await addUser(organizationId, "EMPLOYEE", "Grace Lindqvist");

  jobId = await addJob("JOB-1", "Panel upgrade", [tech]);
  otherJobId = await addJob("JOB-2", "Furnace repair", [tech]);
});

describe("who may open a job thread", () => {
  it("lets in the office and the crew on the job, and nobody else", async () => {
    const id = (await openJobThread({ organizationId, viewer: as(owner), jobId }))!;
    await say(id, owner, "Gate code is 4417.");

    for (const allowed of [owner, office, tech]) {
      expect(await getConversation(organizationId, as(allowed), id)).not.toBeNull();
      expect(
        await threadMessages({ organizationId, viewer: as(allowed), conversationId: id }),
      ).not.toBeNull();
    }

    // Not on the job: the thread answers like one that does not exist.
    expect(await getConversation(organizationId, as(apprentice), id)).toBeNull();
    expect(
      await threadMessages({ organizationId, viewer: as(apprentice), conversationId: id }),
    ).toBeNull();
    expect(await say(id, apprentice, "Hello?")).toBeNull();
    expect(await openJobThread({ organizationId, viewer: as(apprentice), jobId })).toBeNull();
  });

  it("does not open for another business", async () => {
    const stranger = await addUser(otherOrganizationId, "OWNER", "Somebody Else");
    expect(
      await openJobThread({ organizationId: otherOrganizationId, viewer: as(stranger), jobId }),
    ).toBeNull();
  });

  it("goes with the job when a technician is taken off it, and comes with it when one is put on", async () => {
    const id = (await openJobThread({ organizationId, viewer: as(owner), jobId }))!;
    await say(id, owner, "Parts are in the van.");

    await prisma.jobAssignment.deleteMany({ where: { jobId, userId: tech } });
    expect(await getConversation(organizationId, as(tech), id)).toBeNull();
    // Still a member on paper, but it neither shows nor counts.
    expect(await listConversations(organizationId, as(tech))).toEqual([]);
    await say(id, owner, "Anyone free Thursday?");
    expect(await unreadMessageCount(organizationId, as(tech))).toBe(0);

    await prisma.jobAssignment.create({ data: { jobId, userId: apprentice } });
    await joinJobThread({ organizationId, jobId, userIds: [apprentice] });
    expect(await getConversation(organizationId, as(apprentice), id)).not.toBeNull();
    expect((await listConversations(organizationId, as(apprentice))).map((r) => r.id)).toEqual([id]);
  });
});

describe("starting and joining", () => {
  it("is one thread per job, however many ask at once", async () => {
    const [a, b] = await Promise.all([
      openJobThread({ organizationId, viewer: as(owner), jobId }),
      openJobThread({ organizationId, viewer: as(office), jobId }),
    ]);

    expect(a).toBe(b);
    expect(await prisma.conversation.count({ where: { organizationId, jobId } })).toBe(1);
  });

  it("starts with the crew and whoever started it, and reading it is not joining it", async () => {
    const id = (await openJobThread({ organizationId, viewer: as(owner), jobId }))!;
    const members = await prisma.conversationMember.findMany({ where: { conversationId: id } });
    expect(members.map((m) => m.userId).sort()).toEqual([owner, tech].sort());

    // The office opening an existing thread does not put it in their inbox...
    expect(await openJobThread({ organizationId, viewer: as(office), jobId })).toBe(id);
    await say(id, tech, "Found the breaker.");
    expect(await listConversations(organizationId, as(office))).toEqual([]);

    // ...writing in it does, so the reply finds them.
    await say(id, office, "Which one?");
    expect((await listConversations(organizationId, as(office))).map((r) => r.id)).toEqual([id]);
  });

  it("gives somebody put on the job the history without a badge for it", async () => {
    const id = (await openJobThread({ organizationId, viewer: as(owner), jobId }))!;
    await say(id, owner, "One");
    await say(id, owner, "Two");

    await prisma.jobAssignment.create({ data: { jobId, userId: apprentice } });
    expect(await joinJobThread({ organizationId, jobId, userIds: [apprentice, apprentice] })).toBe(1);
    expect(await unreadMessageCount(organizationId, as(apprentice))).toBe(0);

    const thread = await threadMessages({ organizationId, viewer: as(apprentice), conversationId: id });
    expect(thread?.messages.map((m) => m.body)).toEqual(["One", "Two"]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await say(id, owner, "Three");
    expect(await unreadMessageCount(organizationId, as(apprentice))).toBe(1);
  });

  it("does nothing for a job with no thread yet", async () => {
    expect(await joinJobThread({ organizationId, jobId, userIds: [apprentice] })).toBe(0);
    expect(await prisma.conversation.count({ where: { jobId } })).toBe(0);
  });

  it("is called by the job, as the job is called now", async () => {
    const id = (await openJobThread({ organizationId, viewer: as(owner), jobId }))!;
    await prisma.job.update({ where: { id: jobId }, data: { title: "Panel upgrade, 200A" } });

    expect((await getConversation(organizationId, as(owner), id))?.title).toBe(
      "JOB-1 · Panel upgrade, 200A",
    );
    expect(
      conversationTitle({ kind: "JOB", title: null, job: { number: "JOB-9", title: "Leak" } }, []),
    ).toBe("JOB-9 · Leak");
  });
});

describe("photos", () => {
  it("carries only this job's photos, uploaded by the author, not sent before", async () => {
    const id = (await openJobThread({ organizationId, viewer: as(owner), jobId }))!;

    const mine = await addPhoto({ jobId, uploadedById: tech });
    const otherJob = await addPhoto({ jobId: otherJobId, uploadedById: tech });
    const someoneElses = await addPhoto({ jobId, uploadedById: office });
    const document = await addPhoto({ jobId, uploadedById: tech, kind: "DOCUMENT" });

    const message = await say(id, tech, "Before shot", [mine, otherJob, someoneElses, document]);
    expect(message?.photos.map((p) => p.id)).toEqual([mine]);

    // Already sent: dropped, and with no words left there is nothing to post.
    expect(await say(id, tech, "", [mine])).toBeNull();
  });

  it("allows a message that is only photos", async () => {
    const id = (await openJobThread({ organizationId, viewer: as(owner), jobId }))!;
    const photo = await addPhoto({ jobId, uploadedById: tech });

    const message = await say(id, tech, "   ", [photo]);
    expect(message?.body).toBe("");
    expect(message?.photos).toHaveLength(1);

    const inbox = await listConversations(organizationId, as(owner));
    expect(inbox[0].lastMessage).toMatchObject({ body: "", photoCount: 1 });
  });

  it("never attaches a photo in a private conversation", async () => {
    const id = (await openDirectConversation({ organizationId, userId: tech, otherUserId: owner }))!;
    const photo = await addPhoto({ jobId, uploadedById: tech });

    expect(await say(id, tech, "", [photo])).toBeNull();
    const message = await say(id, tech, "Words only", [photo]);
    expect(message?.photos).toEqual([]);
  });

  it("loses a photo deleted from the job, and the whole thread with a deleted job", async () => {
    const id = (await openJobThread({ organizationId, viewer: as(owner), jobId }))!;
    const photo = await addPhoto({ jobId, uploadedById: tech });
    await say(id, tech, "Crack in the drain line", [photo]);

    await prisma.attachment.delete({ where: { id: photo } });
    const thread = await threadMessages({ organizationId, viewer: as(owner), conversationId: id });
    expect(thread?.messages[0].photos).toEqual([]);
    expect(thread?.messages[0].body).toBe("Crack in the drain line");

    await prisma.job.delete({ where: { id: jobId } });
    expect(await prisma.conversation.count({ where: { id } })).toBe(0);
  });
});

describe("the job page's view of it", () => {
  it("shows the latest three and the count, to whoever can open it", async () => {
    expect(await jobThreadSummary(organizationId, as(owner), jobId)).toBeNull();

    const id = (await openJobThread({ organizationId, viewer: as(owner), jobId }))!;
    for (const body of ["One", "Two", "Three", "Four"]) {
      await say(id, owner, body);
    }

    const summary = await jobThreadSummary(organizationId, as(tech), jobId);
    expect(summary?.messageCount).toBe(4);
    expect(summary?.recent.map((m) => m.body)).toEqual(["Two", "Three", "Four"]);
    expect(await jobThreadSummary(organizationId, as(apprentice), jobId)).toBeNull();
  });
});

describe("accepting a photo the browser uploaded itself", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-threads-"));
    process.env.STORAGE_DIR = dir;
    delete process.env.STORAGE_PROVIDER;
    delete process.env.VERCEL;
    resetStorageAdapter();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.STORAGE_DIR;
    resetStorageAdapter();
  });

  function ticketFor(key: string, overrides: Record<string, unknown> = {}) {
    return signUploadTicket({
      key,
      organizationId,
      userId: tech,
      entityType: "job",
      entityId: jobId,
      mimeType: "image/jpeg",
      sizeBytes: 12,
      originalName: "IMG_4411.jpg",
      expiresAt: Date.now() + 60_000,
      ...overrides,
    });
  }

  async function stored() {
    const result = await putFile(
      organizationId,
      new File(["twelve bytes"], "IMG_4411.jpg", { type: "image/jpeg" }),
    );
    if (!result.ok) throw new Error(result.error);
    return result.file.storagePath;
  }

  it("takes the size from the store rather than the ticket", async () => {
    const key = await stored();
    const accepted = await acceptUploadTicket(ticketFor(key, { sizeBytes: 1 }), organizationId);

    expect(accepted).toMatchObject({
      ok: true,
      upload: { key, entityType: "job", entityId: jobId, sizeBytes: 12 },
    });
  });

  it("refuses a forged ticket, another business's, and one for a record it cannot find", async () => {
    const key = await stored();

    expect((await acceptUploadTicket(`${ticketFor(key)}x`, organizationId)).ok).toBe(false);
    expect((await acceptUploadTicket(ticketFor(key), otherOrganizationId)).ok).toBe(false);
    expect(
      (await acceptUploadTicket(ticketFor(key, { entityId: "no-such-job" }), organizationId)).ok,
    ).toBe(false);
    expect((await acceptUploadTicket(42, organizationId)).ok).toBe(false);
  });

  it("says so when the upload never arrived", async () => {
    const accepted = await acceptUploadTicket(
      ticketFor(`${organizationId}/${randomUUID()}.jpg`),
      organizationId,
    );
    expect(accepted).toEqual({ ok: false, problem: "IMG_4411.jpg: the upload did not finish." });
  });

  it("removes an empty upload from the store as it refuses it", async () => {
    const key = await stored();
    fs.writeFileSync(path.join(dir, key), "");

    expect((await acceptUploadTicket(ticketFor(key), organizationId)).ok).toBe(false);
    expect(await statFile(key)).toBeNull();
  });
});

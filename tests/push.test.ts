import { createECDH, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Push notifications.
 *
 * What is pinned: a device can only be signed up at a real push service's
 * address; what is sent is readable by that device's keys and nobody else's;
 * only the field-worthy notifications go to a phone, and team messages go to
 * the others in the thread; a device the push service says is gone is
 * forgotten; and without the server's keys nothing is offered or sent.
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

/** The push services, stood in for: every send is recorded; some answer "gone". */
const sent = vi.hoisted(() => ({ calls: [] as { endpoint: string; payload: string }[], gone: new Set<string>() }));

vi.mock("web-push", async (importOriginal) => {
  const real = (await importOriginal<{ default: typeof import("web-push") }>()).default;
  return {
    default: {
      ...real,
      sendNotification: async (subscription: { endpoint: string }, payload: string) => {
        if (sent.gone.has(subscription.endpoint)) {
          throw Object.assign(new Error("Gone"), { statusCode: 410 });
        }
        sent.calls.push({ endpoint: subscription.endpoint, payload });
        return { statusCode: 201 };
      },
    },
  };
});

import webpush from "web-push";
import { decrypt } from "http_ece";

import { removePushSubscription, savePushSubscription } from "@/app/(app)/settings/profile/push-actions";
import { prisma } from "@/lib/db";
import { notify } from "@/lib/notifications";
import { deliverPush, pushKeys, pushPayload, pushTeamMessage } from "@/lib/push";
import { pushServiceAllowed } from "@/lib/push-services";

const orgs: string[] = [];
let organizationId: string;
let ownerId: string;
let crewId: string;

const vapid = webpush.generateVAPIDKeys();

async function person(name: string, role = "EMPLOYEE") {
  const user = await prisma.user.create({
    data: { organizationId, email: `${randomUUID()}@test.local`, name, passwordHash: "x", role },
  });
  return user.id;
}

/** A device's keys, as a browser would make them. */
function device(endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16).toString("base64url");
  return {
    ecdh,
    auth,
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth } },
  };
}

async function signUp(userId: string, endpoint?: string) {
  const phone = device(endpoint);
  await prisma.pushSubscription.create({
    data: {
      organizationId,
      userId,
      endpoint: phone.subscription.endpoint,
      p256dh: phone.subscription.keys.p256dh,
      auth: phone.auth,
    },
  });
  return phone;
}

async function signInAs(userId: string) {
  session.user = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })) as unknown as Record<string, unknown>;
  session.org = (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })) as unknown as Record<
    string,
    unknown
  >;
}

beforeEach(async () => {
  vi.stubEnv("VAPID_PUBLIC_KEY", vapid.publicKey);
  vi.stubEnv("VAPID_PRIVATE_KEY", vapid.privateKey);
  sent.calls = [];
  sent.gone.clear();
  const org = await prisma.organization.create({ data: { slug: `push-${randomUUID()}`, name: "Push Test Co" } });
  orgs.push(org.id);
  organizationId = org.id;
  ownerId = await person("Olive Owner", "OWNER");
  crewId = await person("Sam Crew");
  await signInAs(crewId);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

describe("where a device may be signed up", () => {
  it("accepts the real push services and nothing else", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://web.push.apple.com/QGx",
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://wns2-bl2p.notify.windows.com/w/?token=x",
    ]) {
      expect(pushServiceAllowed(ok)).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilfcm.googleapis.com.example/x",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost:3000/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "not a url",
    ]) {
      expect(pushServiceAllowed(bad)).toBe(false);
    }
  });

  it("saves a real subscription, refuses a made-up one, and moves a shared device to whoever signed it up last", async () => {
    const phone = device();
    expect(await savePushSubscription(phone.subscription, "Pixel")).toEqual({ ok: true });
    expect(
      await savePushSubscription({ ...phone.subscription, endpoint: "https://attacker.example/hook" }, null),
    ).toMatchObject({ ok: false });
    expect(await savePushSubscription({ endpoint: phone.subscription.endpoint, keys: { p256dh: "<script>", auth: "x" } }, null)).toMatchObject({
      ok: false,
    });

    await signInAs(ownerId);
    await savePushSubscription(phone.subscription, "Pixel");
    const rows = await prisma.pushSubscription.findMany({ where: { organizationId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: ownerId, userAgent: "Pixel" });

    // Only your own device can be removed by you.
    await signInAs(crewId);
    await removePushSubscription(phone.subscription.endpoint);
    expect(await prisma.pushSubscription.count({ where: { organizationId } })).toBe(1);
  });

  it("offers nothing without the server's keys", async () => {
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect(pushKeys()).toBeNull();
    expect(await savePushSubscription(device().subscription, null)).toMatchObject({ ok: false });
    await signUp(crewId);
    expect(await deliverPush([crewId], { title: "Hello" })).toBe(0);
    expect(sent.calls).toHaveLength(0);
  });
});

describe("what is sent", () => {
  it("is readable with the device's own keys, and opens a page inside the app", () => {
    const phone = device();
    const keys = pushKeys()!;
    const request = webpush.generateRequestDetails(phone.subscription, pushPayload({ title: "Assigned: Gutters", body: "Tomorrow at 9", url: "/jobs/abc" }), {
      vapidDetails: keys,
    });
    const plain = decrypt(request.body as Buffer, { version: "aes128gcm", privateKey: phone.ecdh, authSecret: phone.auth });
    expect(JSON.parse(plain.toString())).toEqual({ title: "Assigned: Gutters", body: "Tomorrow at 9", url: "/jobs/abc" });

    const stranger = device();
    expect(() =>
      decrypt(request.body as Buffer, { version: "aes128gcm", privateKey: stranger.ecdh, authSecret: stranger.auth }),
    ).toThrow();

    // A link out of the app is never what a tap opens.
    expect(JSON.parse(pushPayload({ title: "x", url: "https://evil.example" })).url).toBe("/");
  });

  it("goes to every device of the people named, and forgets a device that is gone", async () => {
    const pocket = await signUp(crewId);
    const tablet = await signUp(crewId);
    sent.gone.add(tablet.subscription.endpoint);

    expect(await deliverPush([crewId, crewId], { title: "Hello" })).toBe(1);
    expect(sent.calls.map((call) => call.endpoint)).toEqual([pocket.subscription.endpoint]);
    expect(await prisma.pushSubscription.findMany({ where: { userId: crewId }, select: { endpoint: true } })).toEqual([
      { endpoint: pocket.subscription.endpoint },
    ]);
  });

  it("does not reach somebody deactivated", async () => {
    await signUp(crewId);
    await prisma.user.update({ where: { id: crewId }, data: { isActive: false } });
    expect(await deliverPush([crewId], { title: "Hello" })).toBe(0);
  });
});

describe("which notifications reach a phone", () => {
  it("pushes a new job to the crew put on it, and leaves the office's paperwork in the bell", async () => {
    await signUp(crewId);

    await notify({
      organizationId,
      userIds: [crewId],
      type: "JOB_ASSIGNED",
      title: "Assigned: Gutters",
      body: "Scheduled for Tue at 9:00 AM",
      entityType: "job",
      entityId: "job1",
      actionUrl: "/jobs/job1",
    });
    await notify({ organizationId, userIds: [crewId], type: "INVOICE_DRAFTED", title: "Drafted" });

    await vi.waitFor(() => expect(sent.calls).toHaveLength(1));
    expect(JSON.parse(sent.calls[0].payload)).toEqual({
      title: "Assigned: Gutters",
      body: "Scheduled for Tue at 9:00 AM",
      url: "/jobs/job1",
      tag: "JOB_ASSIGNED:job1",
    });
    // Both still land in the bell.
    expect(await prisma.notification.count({ where: { userId: crewId } })).toBe(2);
  });

  it("pushes a team message to the others in the thread, not to whoever wrote it", async () => {
    await signUp(crewId);
    await signUp(ownerId);
    const thread = await prisma.conversation.create({
      data: {
        organizationId,
        kind: "GROUP",
        title: "Crew A",
        members: { create: [{ userId: crewId }, { userId: ownerId }] },
      },
    });

    await pushTeamMessage({ conversationId: thread.id, authorId: ownerId, authorName: "Olive Owner", body: "", photoCount: 2 });
    await vi.waitFor(() => expect(sent.calls).toHaveLength(1));
    expect(JSON.parse(sent.calls[0].payload)).toEqual({
      title: "Olive Owner in Crew A",
      body: "Sent 2 photos",
      url: `/messages/${thread.id}`,
      tag: `chat:${thread.id}`,
    });
  });
});

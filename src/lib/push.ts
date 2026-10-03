import "server-only";

import { after } from "next/server";
import webpush from "web-push";

import type { NotificationType } from "./constants";
import { prisma } from "./db";

/**
 * Push notifications to phones and browsers.
 *
 * Off until the deployment has a VAPID key pair — the keys that prove to the
 * push services (Google's, Apple's, Mozilla's) that a message comes from this
 * app. Without them nothing is offered and nothing is sent. The desktop app
 * never has them: it is not something a phone can subscribe to.
 *
 * Only a few kinds of notification reach a phone; the rest wait in the bell.
 * A push is a tap on the shoulder, and one for every drafted invoice would
 * soon be switched off.
 */

/** The events that reach a phone. Team messages are pushed on their own. */
export const PUSHED_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "JOB_ASSIGNED",
  "SCHEDULE_CHANGE",
  "ESTIMATE_RESPONSE",
  "PAYMENT_RECEIVED",
  "SERVICE_REQUEST",
]);

export type PushMessage = {
  title: string;
  body?: string | null;
  /** Where tapping it opens, within the app. */
  url?: string | null;
  /** A later push with the same tag replaces this one rather than stacking. */
  tag?: string;
};

type PushEnv = Record<string, string | undefined>;

export function pushKeys(env: PushEnv = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  // Who the push services can contact about this sender: a mail or web address.
  const subject = env.VAPID_SUBJECT?.trim() || "mailto:matlock@matlocksoftware.com";
  return { publicKey, privateKey, subject };
}

/** What a device is sent: small, and opened by the service worker. */
export function pushPayload(message: PushMessage) {
  return JSON.stringify({
    title: message.title.slice(0, 120),
    body: (message.body ?? "").slice(0, 240),
    url: message.url?.startsWith("/") ? message.url : "/",
    tag: message.tag,
  });
}

/**
 * Sends to every device these people signed up, now. A device the push
 * service says is gone — the app was uninstalled, permission withdrawn — is
 * forgotten. Returns how many devices took it.
 */
export async function deliverPush(userIds: string[], message: PushMessage): Promise<number> {
  const keys = pushKeys();
  const people = [...new Set(userIds)].filter(Boolean);
  if (!keys || people.length === 0) return 0;

  const devices = await prisma.pushSubscription.findMany({
    where: { userId: { in: people }, user: { isActive: true } },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (devices.length === 0) return 0;

  const payload = pushPayload(message);
  const gone: string[] = [];
  let delivered = 0;

  await Promise.all(
    devices.map(async (device) => {
      try {
        await webpush.sendNotification(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
          payload,
          {
            vapidDetails: keys,
            // Worth showing for half a day; after that it is old news.
            TTL: 12 * 60 * 60,
            timeout: 10_000,
          },
        );
        delivered += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) gone.push(device.id);
        else console.error(`[push] a device refused a notification (${status ?? "no answer"})`);
      }
    }),
  );

  if (gone.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: gone } } });
  }
  return delivered;
}

/**
 * Sends once the response has gone, so a slow push service never holds up
 * the save that caused it. Outside a request — the morning sweep, a test —
 * it simply goes now, without being waited for.
 */
export function pushSoon(userIds: string[], message: PushMessage) {
  if (!pushKeys() || userIds.length === 0) return;
  const run = () =>
    deliverPush(userIds, message).catch((error) => {
      console.error("[push] sending failed", error);
      return 0;
    });
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * A team message, to the other people in its thread. Tagged by thread, so a
 * busy conversation shows as its latest message rather than a stack of them.
 */
export async function pushTeamMessage(input: {
  conversationId: string;
  authorId: string;
  authorName: string;
  body: string;
  photoCount: number;
}) {
  if (!pushKeys()) return;

  const thread = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: {
      kind: true,
      title: true,
      job: { select: { number: true } },
      members: { where: { userId: { not: input.authorId } }, select: { userId: true } },
    },
  });
  if (!thread || thread.members.length === 0) return;

  const where =
    thread.kind === "JOB" && thread.job
      ? ` on ${thread.job.number}`
      : thread.kind === "GROUP" && thread.title
        ? ` in ${thread.title}`
        : "";
  const photos = input.photoCount === 1 ? "Sent a photo" : `Sent ${input.photoCount} photos`;

  pushSoon(
    thread.members.map((member) => member.userId),
    {
      title: `${input.authorName}${where}`,
      body: input.body || (input.photoCount > 0 ? photos : ""),
      url: `/messages/${input.conversationId}`,
      tag: `chat:${input.conversationId}`,
    },
  );
}

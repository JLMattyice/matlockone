"use server";

import { requireContext } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deliverPush, pushKeys } from "@/lib/push";
import { pushServiceAllowed } from "@/lib/push-services";

/**
 * Signing this phone or browser up for push notifications, and off again.
 *
 * Anybody signed in can, for themselves only. The address a device hands over
 * must belong to a real push service: the server sends to it, so an address
 * of somebody's choosing would make this server knock on any door they named.
 */

type Subscription = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };

const KEY = /^[A-Za-z0-9_-]+={0,2}$/;

export async function savePushSubscription(
  subscription: Subscription,
  userAgent: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const { user, org } = await requireContext();
  if (!pushKeys()) return { ok: false, error: "Notifications are not set up on this server." };

  const endpoint = typeof subscription?.endpoint === "string" ? subscription.endpoint : "";
  const p256dh = typeof subscription?.keys?.p256dh === "string" ? subscription.keys.p256dh : "";
  const auth = typeof subscription?.keys?.auth === "string" ? subscription.keys.auth : "";

  if (
    endpoint.length > 1000 ||
    !pushServiceAllowed(endpoint) ||
    !KEY.test(p256dh) ||
    p256dh.length > 200 ||
    !KEY.test(auth) ||
    auth.length > 100
  ) {
    return { ok: false, error: "This browser offered something that is not a notification address." };
  }

  // One device, one person: a shared tablet signed into by somebody else now
  // notifies them, not whoever had it before.
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: {
      organizationId: org.id,
      userId: user.id,
      endpoint,
      p256dh,
      auth,
      userAgent: userAgent?.slice(0, 300) ?? null,
    },
    update: {
      organizationId: org.id,
      userId: user.id,
      p256dh,
      auth,
      userAgent: userAgent?.slice(0, 300) ?? null,
    },
  });
  return { ok: true };
}

export async function removePushSubscription(endpoint: string): Promise<{ ok: boolean }> {
  const { user } = await requireContext();
  await prisma.pushSubscription.deleteMany({ where: { endpoint: String(endpoint), userId: user.id } });
  return { ok: true };
}

/** Sends one to this person's devices, to show what they will look like. */
export async function sendTestPush(): Promise<{ ok: boolean; delivered: number }> {
  const { user } = await requireContext();
  const delivered = await deliverPush([user.id], {
    title: "Notifications are on",
    body: "This is how Matlock One will reach you about new work, schedule changes and messages.",
    url: "/my-day",
    tag: "test",
  });
  return { ok: delivered > 0, delivered };
}

import "server-only";

import { cache } from "react";

import { prisma } from "./db";

/**
 * Whether the shared demo workspace exists on this deployment.
 *
 * The demo is seeded deliberately (`npm run db:seed`, see DEPLOY.md), and a
 * deployment can be running without it — production was, which is how the
 * homepage came to invite every visitor to "try the demo first" and send them
 * to a sign-in screen with nothing to sign in with.
 *
 * So anything that advertises the demo asks this first, and the offer exists
 * exactly as long as the account does. Seeding the demo turns every mention of
 * it back on; deleting it turns them all off, with nothing to remember to
 * update in between.
 *
 * Wrapped in `cache` because the marketing layout and the page it wraps both
 * ask during one request, and the answer cannot change between them.
 */
export const DEMO_OWNER_EMAIL = "owner@demo.test";

export const demoAvailable = cache(async (): Promise<boolean> => {
  try {
    // Only a flagged demo. An older seed without the flag is a demo nobody
    // guards, and inviting the public into it would let them change it.
    const owner = await prisma.user.findFirst({
      where: {
        email: DEMO_OWNER_EMAIL,
        isActive: true,
        organization: { isDemo: true },
      },
      select: { id: true },
    });
    return owner !== null;
  } catch {
    // A database that cannot be reached should not take the homepage down
    // with it. Not offering the demo is the safe way to be wrong.
    return false;
  }
});

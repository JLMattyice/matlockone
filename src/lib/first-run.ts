import "server-only";

import { prisma } from "@/lib/db";

/**
 * Whether this installation has ever been set up.
 *
 * A brand new copy opens on a sign-in screen with no account to sign in to,
 * and the way forward is a small link at the bottom of it. That is fine for
 * somebody who installed the software on purpose and terrible for everybody
 * being handed it to try.
 */
export async function isFirstRun() {
  return (await prisma.user.count()) === 0;
}

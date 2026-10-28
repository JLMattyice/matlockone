import "server-only";

import { prisma } from "./db";
import { CHECKOUT_ACTION, DEMO_ACTION } from "./signup-funnel";

/**
 * The two sign-up steps nothing else records, written for the operator's
 * Accounts page (see signup-funnel.ts).
 *
 * Neither can throw: a count is never worth failing a sign-in or a checkout
 * over.
 */

/** A business left for PayPal to approve a plan. */
export async function noteCheckout(
  org: { id: string },
  userId: string,
  choice: { plan: string; interval: string },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: org.id,
        userId,
        action: CHECKOUT_ACTION,
        entityType: "Organization",
        entityId: org.id,
        summary: `Went to PayPal for ${choice.plan}, ${choice.interval}.`,
        metadata: JSON.stringify(choice),
      },
    });
  } catch (error) {
    console.error(`[funnel] Could not note checkout for ${org.id}`, error);
  }
}

/** Somebody signed in. Noted only when it was to the demo. */
export async function noteDemoSignIn(user: { id: string; organizationId: string }): Promise<void> {
  try {
    const demo = await prisma.organization.count({ where: { id: user.organizationId, isDemo: true } });
    if (!demo) return;

    await prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        action: DEMO_ACTION,
        entityType: "Organization",
        entityId: user.organizationId,
        summary: "Signed in to the demo.",
      },
    });
  } catch (error) {
    console.error("[funnel] Could not note a demo sign-in", error);
  }
}

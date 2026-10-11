import "server-only";

import { BILLING_PATH } from "./entitlement";
import { systemMailer, type SystemMailer } from "@/lib/checkout/deliver";
import { resolveAppUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { deliverEmail, type OutboundEmail } from "@/lib/email/providers";
import { DEFAULT_TIME_ZONE, formatIn, usableTimeZone } from "@/lib/time-zone";

/**
 * The email a few days before a free month from a code runs out, for a
 * business that has not chosen a plan to follow it.
 *
 * Sent from Matlock's own mailbox (SYSTEM_MAIL_*), like a password reset, to
 * the business's owners — or its admins, if it has no active owner — by the
 * morning run (/api/cron/automations). A business that has lined up a plan
 * hears nothing: its plan starts by itself when the month ends.
 *
 * Once per business. The send is recorded as a row in its audit log, which
 * is also what stops a second: the morning run comes back every day, and
 * Vercel does not promise to call it only once. A row rather than a column,
 * so this needed no change to the database.
 */

/** How long before the end it goes out: the first morning run inside this. */
export const REMINDER_DAYS = 3;

export const REMINDER_ACTION = "billing.free_month_reminder";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The email itself. Pure, so its wording is testable. */
export function freeMonthReminderEmail(input: {
  to: string;
  name: string;
  businessName: string;
  /** "Monday, November 10", on the business's own clock. */
  endsOn: string;
  billingUrl: string;
}): OutboundEmail {
  return {
    to: input.to,
    toName: input.name,
    subject: `Your free month of Matlock One ends ${input.endsOn}`,
    text: [
      `Hello ${input.name},`,
      "",
      `The free month for ${input.businessName} on Matlock One ends on ${input.endsOn}.`,
      "",
      "To keep going, choose a plan before then:",
      "",
      input.billingUrl,
      "",
      `Nothing is charged until the free month is over. PayPal takes the first`,
      `payment on ${input.endsOn}, and you can cancel any time from the same page.`,
      "",
      `If you don't choose one, ${input.businessName} locks when the free month ends.`,
      "Nothing is deleted: everything stays where it is, and choosing a plan opens",
      "it again.",
      "",
      "— Matlock One",
    ].join("\n"),
  };
}

export type ReminderOptions = {
  mailer?: SystemMailer | null;
  send?: typeof deliverEmail;
  now?: Date;
};

export type ReminderResult = {
  /** Businesses whose free month ends within REMINDER_DAYS and have not been told. */
  due: number;
  /** Of those, the ones at least one email reached. */
  reminded: number;
  failed: number;
  /** No mailbox on this deployment, so nothing was sent and nothing recorded. */
  notConfigured?: true;
};

/**
 * Emails every business whose free month ends within REMINDER_DAYS, has no
 * plan lined up, and has not been reminded. A business none of whose emails
 * went out is not recorded, so the next morning tries again — while the
 * month lasts.
 */
export async function remindFreeMonths(options: ReminderOptions = {}): Promise<ReminderResult> {
  const { send = deliverEmail, now = new Date() } = options;
  const mailer = options.mailer === undefined ? systemMailer() : options.mailer;
  if (!mailer) return { due: 0, reminded: 0, failed: 0, notConfigured: true };

  const ending = await prisma.organization.findMany({
    where: {
      isDemo: false,
      billingExempt: false,
      subscriptionId: null,
      trialEndsAt: { gt: now, lte: new Date(now.getTime() + REMINDER_DAYS * DAY_MS) },
    },
    select: {
      id: true,
      name: true,
      timeZone: true,
      trialEndsAt: true,
      users: {
        where: { isActive: true, role: { in: ["OWNER", "ADMIN"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, email: true, role: true },
      },
    },
  });
  if (ending.length === 0) return { due: 0, reminded: 0, failed: 0 };

  const told = new Set(
    (
      await prisma.auditLog.findMany({
        where: { action: REMINDER_ACTION, organizationId: { in: ending.map((org) => org.id) } },
        select: { organizationId: true },
      })
    ).map((row) => row.organizationId),
  );

  const billingUrl = `${resolveAppUrl()}${BILLING_PATH}`;
  const result: ReminderResult = { due: 0, reminded: 0, failed: 0 };

  for (const org of ending) {
    if (told.has(org.id) || !org.trialEndsAt) continue;
    result.due++;

    const owners = org.users.filter((user) => user.role === "OWNER");
    const recipients = owners.length > 0 ? owners : org.users;
    const endsOn = formatIn(org.trialEndsAt, "EEEE, MMMM d", usableTimeZone(org.timeZone) ?? DEFAULT_TIME_ZONE);

    const reached: string[] = [];
    for (const user of recipients) {
      try {
        const sent = await send(
          mailer.provider,
          mailer.config,
          mailer.secret,
          freeMonthReminderEmail({ to: user.email, name: user.name, businessName: org.name, endsOn, billingUrl }),
        );
        if (sent.ok) reached.push(user.email);
        else console.error(`[free-month] Could not email ${user.id} of ${org.id}: ${sent.error}`);
      } catch (error) {
        console.error(`[free-month] Could not email ${user.id} of ${org.id}`, error);
      }
    }

    if (reached.length === 0) {
      result.failed++;
      continue;
    }

    await prisma.auditLog.create({
      data: {
        organizationId: org.id,
        action: REMINDER_ACTION,
        entityType: "Organization",
        entityId: org.id,
        summary: `Emailed ${reached.join(", ")} that the free month ends ${endsOn}.`,
      },
    });
    result.reminded++;
  }

  return result;
}

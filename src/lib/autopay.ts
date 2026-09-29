import "server-only";

import { randomBytes } from "node:crypto";

import { addDays, endOfDay, subDays } from "date-fns";

import { record } from "./activity";
import { entitlement } from "./billing/entitlement";
import type { RecurrenceFrequency } from "./constants";
import { prisma } from "./db";
import { formatMoney } from "./money";
import { notify } from "./notifications";
import { recordRemotePayments, resolveProcessor, type ConnectedProcessor } from "./payments/account";
import {
  cancelAutopaySubscription,
  createAutopayPlan,
  getAutopaySubscription,
  listAutopayPayments,
  paypalCycle,
  startAutopaySubscription,
} from "./payments/paypal-subscriptions";
import { describeRecurrence, nextInSeries } from "./recurrence";
import { whoHandlesBilling } from "./recurring-invoices";
import { runEventWorkflows } from "./workflows/run";

/**
 * Auto-pay for repeating invoices, on PayPal.
 *
 * The business offers it on a repeating invoice; the customer follows the
 * invite, approves once on PayPal's pages, and PayPal charges them every
 * period from then on. Each charge is matched to that period's invoice in
 * the series and recorded against it, which marks the invoice paid.
 *
 * Three things this is careful about, in order of how much they would cost:
 *
 * **Charging twice.** PayPal's approval link goes stale within hours, so each
 * click on the invite makes a fresh subscription, and every one is kept and
 * watched. If two are ever approved, all but the first are cancelled.
 *
 * **Charging after it should have stopped.** Stopping the repeat or turning
 * auto-pay off cancels at PayPal; a repeat with an end date is given exactly
 * as many payments as it has dates left; and any subscription still charging
 * for a series whose auto-pay is off is cancelled on sight.
 *
 * **Recording money twice.** Every charge is stored under PayPal's own
 * transaction id behind the same unique index as every other processor
 * payment, so looking again records nothing again.
 */

/** Subscriptions PayPal may still charge, or that a customer may yet approve. */
export const LIVE_STATUSES = ["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED"];

/** Subscriptions that are, or are about to be, taking money. */
export const COLLECTING_STATUSES = ["APPROVED", "ACTIVE", "SUSPENDED"];

/**
 * How long a subscription nobody approved is watched for. PayPal's link is
 * dead long before this; the margin is for a customer who approved at the
 * last moment before a run.
 */
const PENDING_DAYS = 3;

/** How long a made-but-unapproved subscription's link is handed out again. */
const REUSE_APPROVAL_MS = 2 * 60 * 60 * 1000;

/** How far a charge's date may sit from its invoice's and still be its. */
const MATCH_DAYS = 3;

export type AutopayResult<T = null> = { ok: true; value: T } | { ok: false; error: string };

/** The whole credential in an invite link. 24 random bytes, 32 characters. */
const newToken = () => randomBytes(24).toString("base64url");

async function paypalFor(organizationId: string): Promise<ConnectedProcessor | null> {
  const processor = await resolveProcessor(organizationId);
  return processor?.provider === "PAYPAL" ? processor : null;
}

/** The invoice each period copies, which is also what auto-pay charges. */
function latestInSeries(scheduleId: string, organizationId: string) {
  return prisma.invoice.findFirst({
    where: { scheduleId, organizationId, status: { not: "CANCELLED" } },
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      number: true,
      title: true,
      totalCents: true,
      clientId: true,
      client: { select: { displayName: true, email: true } },
    },
  });
}

// ------------------------------------------------------------------ offer ---

/**
 * Makes a series ready for its customer to turn auto-pay on.
 *
 * Creates the PayPal plan — the amount of the latest invoice, on the series'
 * rhythm — and the invite link. Nothing is charged and nobody is emailed;
 * the business sends the invite when it is ready.
 */
export async function offerAutopay(input: {
  organization: { id: string; name: string; currency: string; locale: string };
  scheduleId: string;
  actorId: string;
}): Promise<AutopayResult<{ token: string }>> {
  const { organization } = input;

  const paypal = await paypalFor(organization.id);
  if (!paypal) {
    return {
      ok: false,
      error: "Auto-pay works through PayPal. Connect PayPal under Settings → Payments first.",
    };
  }

  const schedule = await prisma.invoiceSchedule.findFirst({
    where: { id: input.scheduleId, organizationId: organization.id, isActive: true },
    include: { autopaySubscriptions: { where: { status: { in: COLLECTING_STATUSES } } } },
  });
  if (!schedule) return { ok: false, error: "This invoice is not repeating any more." };
  if (schedule.autopaySubscriptions.length > 0) {
    return { ok: false, error: "Auto-pay is already on for this customer." };
  }

  const cycle = paypalCycle(schedule.frequency, schedule.interval);
  if (!cycle.ok) return cycle;

  const latest = await latestInSeries(schedule.id, organization.id);
  if (!latest) return { ok: false, error: "There is no invoice in this series to charge for." };
  if (latest.totalCents <= 0) {
    return { ok: false, error: "The latest invoice in this series is for nothing, so there is nothing to charge." };
  }

  const rhythm = describeRecurrence(schedule).toLowerCase();
  const what = latest.title ?? `Invoice ${latest.number}`;

  const plan = await createAutopayPlan(paypal, {
    key: `${schedule.id}-${Date.now()}`,
    name: `${organization.name} — ${what}`,
    description: `${what} for ${latest.client.displayName}, ${rhythm}`,
    amountCents: latest.totalCents,
    currency: organization.currency,
    frequency: schedule.frequency,
    interval: schedule.interval,
  });
  if (!plan.ok) return plan;

  const token = schedule.autopayToken ?? newToken();

  await prisma.invoiceSchedule.update({
    where: { id: schedule.id },
    data: {
      autopayToken: token,
      autopayPlanId: plan.value.planId,
      autopayAmountCents: latest.totalCents,
      autopayOfferedAt: new Date(),
    },
  });

  await record({
    organizationId: organization.id,
    userId: input.actorId,
    action: "invoice.autopay",
    entityType: "INVOICE",
    entityId: latest.id,
    summary: `Auto-pay offered to ${latest.client.displayName}: ${formatMoney(
      latest.totalCents,
      organization.currency,
      organization.locale,
    )} ${rhythm}`,
  });

  return { ok: true, value: { token } };
}

// ---------------------------------------------------------------- turn off ---

/**
 * Stops auto-pay for a series: cancels at PayPal and kills the invite link.
 *
 * Every subscription that could still charge is cancelled, not only the one
 * believed to be in use. One never approved cannot be cancelled at PayPal and
 * is left to be watched until it lapses — and cancelled on sight should the
 * customer approve it after all, since the series' auto-pay is off.
 */
export async function turnOffAutopay(input: {
  organizationId: string;
  scheduleId: string;
  actorId: string | null;
  reason: string;
}): Promise<AutopayResult> {
  const schedule = await prisma.invoiceSchedule.findFirst({
    where: { id: input.scheduleId, organizationId: input.organizationId },
    include: { autopaySubscriptions: { where: { status: { in: LIVE_STATUSES } } } },
  });
  if (!schedule) return { ok: false, error: "That repeating invoice no longer exists." };

  const collecting = schedule.autopaySubscriptions.filter((row) =>
    COLLECTING_STATUSES.includes(row.status),
  );

  const paypal = collecting.length > 0 ? await paypalFor(input.organizationId) : null;
  if (collecting.length > 0 && !paypal) {
    return {
      ok: false,
      error:
        "PayPal is not connected any more, so auto-pay cannot be cancelled from here. Reconnect it under Settings → Payments, or cancel it in your PayPal account.",
    };
  }

  for (const row of collecting) {
    const cancelled = await cancelAutopaySubscription(paypal!, row.externalId, input.reason);
    if (!cancelled.ok) return { ok: false, error: `PayPal would not cancel it: ${cancelled.error}` };

    await prisma.autopaySubscription.update({
      where: { id: row.id },
      data: { status: "CANCELLED", checkedAt: new Date() },
    });
  }

  await prisma.invoiceSchedule.update({
    where: { id: schedule.id },
    data: {
      autopayToken: null,
      autopayPlanId: null,
      autopayAmountCents: null,
      autopayOfferedAt: null,
    },
  });

  if (collecting.length > 0 || schedule.autopayOfferedAt) {
    const latest = await latestInSeries(schedule.id, input.organizationId);
    if (latest) {
      await record({
        organizationId: input.organizationId,
        userId: input.actorId,
        action: "invoice.autopay",
        entityType: "INVOICE",
        entityId: latest.id,
        summary: `Auto-pay turned off for ${latest.client.displayName}`,
      });
    }
  }

  return { ok: true, value: null };
}

// ------------------------------------------------------------------ invite ---

export type InviteView = {
  scheduleId: string;
  organization: {
    name: string;
    primaryColor: string | null;
    currency: string;
    locale: string;
  };
  clientName: string;
  what: string;
  amountCents: number;
  rhythm: string;
  firstPayment: Date;
  endDate: Date | null;
  /** Auto-pay is already set up, so there is nothing to do. */
  alreadyOn: boolean;
};

/** When the first payment would be, if the customer approved now. */
function firstPaymentFor(schedule: { nextIssueDate: Date }, now: Date) {
  const soonest = new Date(now.getTime() + 10 * 60 * 1000);
  return schedule.nextIssueDate > soonest ? schedule.nextIssueDate : soonest;
}

async function scheduleByToken(token: string) {
  if (!token || token.length < 20) return null;

  return prisma.invoiceSchedule.findUnique({
    where: { autopayToken: token },
    include: {
      organization: true,
      autopaySubscriptions: { orderBy: { createdAt: "desc" } },
    },
  });
}

/**
 * What the customer's invite page shows. Null when the link does not work —
 * unknown, turned off, the repeat stopped, or nothing to show a customer.
 */
export async function autopayInvite(token: string, now = new Date()): Promise<InviteView | null> {
  const schedule = await scheduleByToken(token);
  if (!schedule || !schedule.isActive || !schedule.autopayPlanId || !schedule.autopayAmountCents) {
    return null;
  }
  if (schedule.organization.isDemo) return null;

  const latest = await latestInSeries(schedule.id, schedule.organizationId);
  if (!latest) return null;

  return {
    scheduleId: schedule.id,
    organization: {
      name: schedule.organization.name,
      primaryColor: schedule.organization.primaryColor,
      currency: schedule.organization.currency,
      locale: schedule.organization.locale,
    },
    clientName: latest.client.displayName,
    what: latest.title ?? `Invoice ${latest.number}`,
    amountCents: schedule.autopayAmountCents,
    rhythm: describeRecurrence(schedule).toLowerCase(),
    firstPayment: firstPaymentFor(schedule, now),
    endDate: schedule.endDate,
    alreadyOn: schedule.autopaySubscriptions.some((row) => COLLECTING_STATUSES.includes(row.status)),
  };
}

/**
 * How many payments a repeat with an end date has left from `first`.
 *
 * Given to PayPal on the subscription, so it stops by itself after the last
 * one rather than relying on anybody remembering to cancel it.
 */
export function paymentsUntil(
  schedule: { frequency: string; interval: number; anchorDate: Date },
  first: Date,
  endDate: Date,
): number {
  const last = endOfDay(endDate);
  let count = 0;
  let cursor = first;

  while (cursor <= last && count < 1_000) {
    count++;
    cursor = nextInSeries(cursor, schedule.frequency as RecurrenceFrequency, schedule.interval, schedule.anchorDate);
  }

  return count;
}

/**
 * Where to send a customer who has pressed the button on their invite.
 *
 * A subscription made in the last two hours and not yet approved is handed
 * out again — a customer who went back and pressed again is still on the same
 * errand. Anything older gets a new one, since PayPal's link will have gone
 * stale.
 */
export async function startAutopay(
  token: string,
  urls: { returnUrl: string; cancelUrl: string },
  now = new Date(),
): Promise<AutopayResult<{ redirect: string } | { alreadyOn: true }>> {
  const schedule = await scheduleByToken(token);
  if (!schedule || !schedule.isActive || !schedule.autopayPlanId || !schedule.autopayAmountCents) {
    return { ok: false, error: "unavailable" };
  }

  const org = schedule.organization;
  if (org.isDemo || !entitlement(org, now).ok) return { ok: false, error: "unavailable" };

  if (schedule.autopaySubscriptions.some((row) => COLLECTING_STATUSES.includes(row.status))) {
    return { ok: true, value: { alreadyOn: true } };
  }

  const recent = schedule.autopaySubscriptions.find(
    (row) =>
      row.status === "APPROVAL_PENDING" &&
      row.approveUrl &&
      now.getTime() - row.createdAt.getTime() < REUSE_APPROVAL_MS,
  );
  if (recent?.approveUrl) return { ok: true, value: { redirect: recent.approveUrl } };

  const paypal = await paypalFor(org.id);
  if (!paypal) return { ok: false, error: "unavailable" };

  const latest = await latestInSeries(schedule.id, org.id);
  if (!latest) return { ok: false, error: "unavailable" };

  const first = firstPaymentFor(schedule, now);
  const remaining = schedule.endDate ? paymentsUntil(schedule, first, schedule.endDate) : null;
  if (remaining === 0) return { ok: false, error: "unavailable" };

  const started = await startAutopaySubscription(paypal, {
    planId: schedule.autopayPlanId,
    customId: schedule.id,
    startTime: first,
    brandName: org.name,
    email: latest.client.email,
    totalPayments: remaining,
    amountCents: schedule.autopayAmountCents,
    currency: org.currency,
    ...urls,
  });
  if (!started.ok) {
    console.error(`[auto-pay] PayPal would not start a subscription for schedule ${schedule.id}: ${started.error}`);
    return { ok: false, error: "unavailable" };
  }

  await prisma.autopaySubscription.create({
    data: {
      organizationId: org.id,
      scheduleId: schedule.id,
      provider: "PAYPAL",
      externalId: started.value.id,
      status: started.value.status,
      approveUrl: started.value.approveUrl,
      amountCents: schedule.autopayAmountCents,
      currency: org.currency,
      startsAt: first,
    },
  });

  return { ok: true, value: { redirect: started.value.approveUrl } };
}

// -------------------------------------------------------------------- sync ---

export type SyncOutcome = {
  checked: number;
  /** Payments recorded against invoices. */
  collected: number;
  /** Charges found with no open invoice of theirs yet; looked at again next time. */
  unmatched: number;
  failed: string[];
};

/**
 * Asks PayPal where every live subscription stands, and records what it has
 * collected.
 *
 * What the morning run calls after making the day's drafts — so a charge
 * taken this morning finds this morning's invoice — and what "Check now" and
 * the invite's return page call for one series.
 */
export async function syncAutopay(
  options: { organizationId?: string; scheduleId?: string; now?: Date } = {},
): Promise<SyncOutcome> {
  const now = options.now ?? new Date();
  const outcome: SyncOutcome = { checked: 0, collected: 0, unmatched: 0, failed: [] };

  const rows = await prisma.autopaySubscription.findMany({
    where: {
      status: { in: LIVE_STATUSES },
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      organization: { isDemo: false },
    },
    include: { schedule: true, organization: true },
    orderBy: { createdAt: "asc" },
    take: 1_000,
  });

  const processors = new Map<string, ConnectedProcessor | null>();
  // Told about once the duplicates are settled, so a second approval that is
  // about to be cancelled is not announced as auto-pay being turned on.
  const changed: { row: (typeof rows)[number]; status: string }[] = [];

  for (const row of rows) {
    const org = row.organization;

    try {
      // Never approved, and long past the point it could be.
      if (row.status === "APPROVAL_PENDING" && row.createdAt < subDays(now, PENDING_DAYS)) {
        await prisma.autopaySubscription.update({
          where: { id: row.id },
          data: { status: "EXPIRED", checkedAt: now },
        });
        continue;
      }

      // A locked business cannot see what would be recorded. Its payments
      // wait at PayPal, and are recorded when it reopens.
      if (!entitlement(org, now).ok) continue;

      if (!processors.has(org.id)) processors.set(org.id, await paypalFor(org.id));
      const paypal = processors.get(org.id);
      if (!paypal) continue;

      const state = await getAutopaySubscription(paypal, row.externalId);
      if (!state.ok) {
        outcome.failed.push(row.id);
        console.error(`[auto-pay] could not check subscription ${row.externalId}: ${state.error}`);
        continue;
      }
      outcome.checked++;

      const before = row.status;
      const after = state.value.status;

      await prisma.autopaySubscription.update({
        where: { id: row.id },
        data: { status: after, payerEmail: state.value.payerEmail ?? row.payerEmail, checkedAt: now },
      });

      // Charging for a series whose auto-pay was turned off: an old invite
      // approved late. Cancel it before it takes anything more.
      if (COLLECTING_STATUSES.includes(after) && !row.schedule.autopayToken) {
        await cancelAutopaySubscription(paypal, row.externalId, "Auto-pay was turned off by the business.");
        await prisma.autopaySubscription.update({ where: { id: row.id }, data: { status: "CANCELLED" } });
      } else if (before !== after) {
        changed.push({ row, status: after });
      }

      // Money moves on anything that was, or still is, collecting.
      if (COLLECTING_STATUSES.includes(after) || COLLECTING_STATUSES.includes(before)) {
        const counted = await collect(paypal, row, now);
        outcome.collected += counted.collected;
        outcome.unmatched += counted.unmatched;
      }
    } catch (error) {
      outcome.failed.push(row.id);
      console.error(`[auto-pay] checking subscription ${row.externalId} failed`, error);
    }
  }

  await cancelSeconds(rows.map((row) => row.scheduleId), processors);

  for (const { row, status } of changed) {
    const current = await prisma.autopaySubscription.findUnique({ where: { id: row.id }, select: { status: true } });
    if (current?.status === status) await announce(row, status);
  }

  return outcome;
}

/** Tells the business about a subscription changing state. */
async function announce(
  row: { organizationId: string; scheduleId: string; amountCents: number; currency: string; startsAt: Date },
  status: string,
) {
  const schedule = await prisma.invoiceSchedule.findUnique({ where: { id: row.scheduleId } });
  const latest = await latestInSeries(row.scheduleId, row.organizationId);
  if (!schedule || !latest) return;

  const org = await prisma.organization.findUnique({ where: { id: row.organizationId } });
  const money = formatMoney(row.amountCents, row.currency, org?.locale ?? "en-US");
  const who = latest.client.displayName;

  const message =
    status === "ACTIVE" || status === "APPROVED"
      ? {
          title: `${who} turned on auto-pay`,
          body: `PayPal will collect ${money} ${describeRecurrence(schedule).toLowerCase()}, starting ${row.startsAt.toDateString()}.`,
        }
      : status === "SUSPENDED"
        ? {
            title: `Auto-pay for ${who} is on hold`,
            body: "PayPal could not collect a payment after several tries. Their invoices will need paying another way until it is sorted out.",
          }
        : status === "CANCELLED" || status === "EXPIRED"
          ? {
              title: `Auto-pay for ${who} has stopped`,
              body:
                status === "EXPIRED"
                  ? "It reached the end of its payments."
                  : "It was cancelled at PayPal. Their invoices will need sending and paying the usual way.",
            }
          : null;
  if (!message) return;

  await notify({
    organizationId: row.organizationId,
    userIds: await whoHandlesBilling(row.organizationId, schedule.createdById),
    type: "AUTOPAY",
    ...message,
    entityType: "invoice",
    entityId: latest.id,
    actionUrl: `/invoices/${latest.id}`,
  });

  if (status === "ACTIVE" || status === "APPROVED") {
    await record({
      organizationId: row.organizationId,
      userId: null,
      action: "invoice.autopay",
      entityType: "INVOICE",
      entityId: latest.id,
      summary: `${who} turned on auto-pay: ${money} ${describeRecurrence(schedule).toLowerCase()}`,
    });
  }
}

/**
 * Records each charge against the invoice for its period.
 *
 * That is the oldest invoice in the series still owing, issued no earlier
 * than auto-pay started and no later than a few days after the charge. A
 * charge with none — taken before the morning run made that period's draft —
 * is left for the next look, and is not lost: it stays in PayPal's list.
 */
async function collect(
  paypal: ConnectedProcessor,
  row: {
    id: string;
    organizationId: string;
    scheduleId: string;
    externalId: string;
    startsAt: Date;
    createdAt: Date;
    schedule: { createdById: string | null };
    organization: { currency: string; locale: string };
  },
  now: Date,
): Promise<{ collected: number; unmatched: number }> {
  const listed = await listAutopayPayments(paypal, row.externalId, subDays(row.createdAt, 1), now);
  if (!listed.ok) throw new Error(listed.error);

  let collected = 0;
  let unmatched = 0;

  for (const payment of listed.value.sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime())) {
    const seen = await prisma.payment.findFirst({
      where: { organizationId: row.organizationId, provider: "PAYPAL", externalId: payment.externalId },
      select: { id: true },
    });
    if (seen) continue;

    const invoice = await prisma.invoice.findFirst({
      where: {
        organizationId: row.organizationId,
        scheduleId: row.scheduleId,
        status: { not: "CANCELLED" },
        balanceCents: { gt: 0 },
        issueDate: { gte: subDays(row.startsAt, MATCH_DAYS), lte: addDays(payment.paidAt, MATCH_DAYS) },
      },
      orderBy: [{ issueDate: "asc" }, { createdAt: "asc" }],
      select: { id: true, number: true, status: true, clientId: true, client: { select: { displayName: true } } },
    });

    if (!invoice) {
      unmatched++;
      continue;
    }

    // Paid by auto-pay, so issued: a draft cannot be marked paid, and there
    // is nothing left for anybody to send.
    if (invoice.status === "DRAFT") {
      await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "SENT" } });
    }

    const result = await recordRemotePayments({
      organizationId: row.organizationId,
      invoiceId: invoice.id,
      clientId: invoice.clientId,
      provider: "PAYPAL",
      payments: [payment],
    });
    if (result.recorded === 0) continue;
    collected++;

    const money = (cents: number) => formatMoney(cents, row.organization.currency, row.organization.locale);

    await notify({
      organizationId: row.organizationId,
      userIds: await whoHandlesBilling(row.organizationId, row.schedule.createdById),
      type: "PAYMENT_RECEIVED",
      title: `${money(payment.amountCents)} collected by auto-pay on ${invoice.number}`,
      body: result.settled ? "Paid in full." : `${money(result.balanceCents)} still outstanding.`,
      entityType: "invoice",
      entityId: invoice.id,
      actionUrl: `/invoices/${invoice.id}`,
    });

    await record({
      organizationId: row.organizationId,
      userId: null,
      action: "payment.recorded",
      entityType: "INVOICE",
      entityId: invoice.id,
      summary: `${money(payment.amountCents)} collected by PayPal auto-pay on invoice ${invoice.number}${
        result.settled ? " — paid in full" : ""
      }`,
      metadata: { amountCents: payment.amountCents, settled: result.settled, autopay: true },
    });

    if (result.settled) {
      await runEventWorkflows("invoice.paid", {
        organizationId: row.organizationId,
        entityType: "INVOICE",
        entityId: invoice.id,
        subject: invoice.client.displayName,
        document: invoice.number,
        clientId: invoice.clientId,
      });
    }
  }

  return { collected, unmatched };
}

/**
 * Cancels every collecting subscription on a series but the first.
 *
 * Two can only exist if the customer approved two invites — two tabs, two
 * clicks a few hours apart. The first approved stays; the rest would charge
 * them again for the same period.
 */
async function cancelSeconds(
  scheduleIds: string[],
  processors: Map<string, ConnectedProcessor | null>,
) {
  for (const scheduleId of [...new Set(scheduleIds)]) {
    const collecting = await prisma.autopaySubscription.findMany({
      where: { scheduleId, status: { in: COLLECTING_STATUSES } },
      orderBy: { createdAt: "asc" },
    });
    if (collecting.length < 2) continue;

    const paypal = processors.get(collecting[0].organizationId);
    if (!paypal) continue;

    for (const extra of collecting.slice(1)) {
      const cancelled = await cancelAutopaySubscription(
        paypal,
        extra.externalId,
        "A second auto-pay was set up by mistake; the first one stays.",
      );
      if (!cancelled.ok) {
        console.error(`[auto-pay] could not cancel duplicate ${extra.externalId}: ${cancelled.error}`);
        continue;
      }
      await prisma.autopaySubscription.update({ where: { id: extra.id }, data: { status: "CANCELLED" } });

      const [schedule, latest] = await Promise.all([
        prisma.invoiceSchedule.findUnique({ where: { id: scheduleId } }),
        latestInSeries(scheduleId, extra.organizationId),
      ]);
      if (!schedule || !latest) continue;

      await notify({
        organizationId: extra.organizationId,
        userIds: await whoHandlesBilling(extra.organizationId, schedule.createdById),
        type: "AUTOPAY",
        title: `${latest.client.displayName} set up auto-pay twice`,
        body: `The second one (PayPal ${extra.externalId}) was cancelled so they are not charged twice. If PayPal took a payment on it, refund that in PayPal.`,
        entityType: "invoice",
        entityId: latest.id,
        actionUrl: `/invoices/${latest.id}`,
      });
    }
  }
}

// ------------------------------------------------------------------ status ---

type Collecting = {
  token: string | null;
  amountCents: number;
  payerEmail: string | null;
  startsAt: Date;
  checkedAt: Date | null;
};

export type AutopayStatus =
  | { state: "unavailable"; reason: string }
  | { state: "off" }
  | { state: "invited"; token: string; amountCents: number }
  | ({ state: "on" } & Collecting)
  | ({ state: "on-hold" } & Collecting);

/** Where auto-pay stands for a series, for the invoice page. */
export async function autopayStatus(
  organizationId: string,
  schedule: {
    id: string;
    isActive: boolean;
    frequency: string;
    interval: number;
    autopayToken: string | null;
    autopayAmountCents: number | null;
  },
): Promise<AutopayStatus> {
  const collecting = await prisma.autopaySubscription.findFirst({
    where: { scheduleId: schedule.id, status: { in: COLLECTING_STATUSES } },
    orderBy: { createdAt: "asc" },
  });

  if (collecting) {
    return {
      state: collecting.status === "SUSPENDED" ? ("on-hold" as const) : ("on" as const),
      token: schedule.autopayToken,
      amountCents: collecting.amountCents,
      payerEmail: collecting.payerEmail,
      startsAt: collecting.startsAt,
      checkedAt: collecting.checkedAt,
    };
  }

  if (schedule.autopayToken && schedule.autopayAmountCents) {
    return { state: "invited", token: schedule.autopayToken, amountCents: schedule.autopayAmountCents };
  }

  if (!schedule.isActive) return { state: "unavailable", reason: "Start the repeat again to offer auto-pay." };

  const cycle = paypalCycle(schedule.frequency, schedule.interval);
  if (!cycle.ok) return { state: "unavailable", reason: cycle.error };

  if (!(await paypalFor(organizationId))) {
    return {
      state: "unavailable",
      reason: "Connect PayPal under Settings → Payments to let this customer pay automatically.",
    };
  }

  return { state: "off" };
}

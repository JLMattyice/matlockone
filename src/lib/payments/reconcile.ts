import "server-only";

import { record } from "../activity";
import { entitlement } from "../billing/entitlement";
import { INVOICE_OPEN_STATUSES } from "../constants";
import { prisma } from "../db";
import { formatMoney } from "../money";
import { notify } from "../notifications";
import { sendToQuickBooksSoon } from "../quickbooks/sync";
import { whoHandlesBilling } from "../recurring-invoices";
import { runEventWorkflows } from "../workflows/run";
import { recordRemotePayments, resolveProcessor, type ConnectedProcessor } from "./account";
import { isPaymentProvider, PAYMENT_PROVIDER_META } from "./catalog";
import { ensurePaypalWebhook } from "./paypal-webhooks";

/**
 * Asking a processor what has been paid against an invoice, and writing it in.
 *
 * One path for every way the question gets asked — somebody pressing Check for
 * payment, PayPal saying an invoice was paid, the morning run going through
 * every open pay link — so a payment that lands by any of them is announced,
 * logged and acted on the same way. They used to differ: the button wrote the
 * payment and stopped, so "thank them for paying" never fired for money that
 * came in online.
 */

export type ReconcileOutcome =
  | {
      ok: true;
      recorded: number;
      amountCents: number;
      settled: boolean;
      balanceCents: number;
      /** The processor's name, for saying where the answer came from. */
      providerLabel: string;
    }
  | {
      ok: false;
      /**
       * Whether asking again later could give a different answer. True when
       * the processor could not be reached; false when nothing would change —
       * a draft, a processor with no way to report payments.
       */
      retry: boolean;
      error: string;
    };

const refused = (error: string): ReconcileOutcome => ({ ok: false, retry: false, error });

export async function reconcileInvoice(input: {
  organizationId: string;
  invoiceId: string;
  /** Who asked, or null when a processor or the morning run did. */
  userId: string | null;
  /** Already resolved by a caller going through many invoices. */
  processor?: ConnectedProcessor | null;
}): Promise<ReconcileOutcome> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: {
      id: true,
      number: true,
      status: true,
      clientId: true,
      createdById: true,
      paymentRef: true,
      paymentProvider: true,
      client: { select: { displayName: true } },
      organization: { select: { currency: true, locale: true } },
    },
  });
  if (!invoice) return refused("That invoice no longer exists.");

  const processor =
    input.processor !== undefined
      ? input.processor
      : await resolveProcessor(input.organizationId);
  if (!processor) {
    return refused("No payment processor is connected. Set one up under Settings → Payments.");
  }

  if (invoice.status === "DRAFT") {
    return refused("Send the invoice before recording payments against it.");
  }

  const meta = PAYMENT_PROVIDER_META[processor.provider];
  if (!meta.reconciles) {
    return refused(
      `${meta.label} cannot tell Matlock One what it collected. Record the payment by hand once it lands.`,
    );
  }

  // A link made through one processor means nothing to the next. Asking Stripe
  // about a PayPal invoice id only produces a confusing error from Stripe.
  if (invoice.paymentProvider && invoice.paymentProvider !== processor.provider) {
    const was = isPaymentProvider(invoice.paymentProvider)
      ? PAYMENT_PROVIDER_META[invoice.paymentProvider].label
      : "another processor";
    return refused(
      `This link was made through ${was}, which is no longer connected, so Matlock One cannot ask about it. Record the payment by hand once it lands.`,
    );
  }

  const listed = await processor.adapter.listPayments(
    invoice.paymentRef,
    processor.config,
    processor.credentials,
  );
  if (!listed.ok) return { ok: false, retry: true, error: listed.error };

  const outcome = await recordRemotePayments({
    organizationId: input.organizationId,
    invoiceId: invoice.id,
    clientId: invoice.clientId,
    provider: processor.provider,
    payments: listed.value,
  });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { paymentCheckedAt: new Date() },
  });

  if (outcome.recorded > 0) {
    const money = (cents: number) =>
      formatMoney(cents, invoice.organization.currency, invoice.organization.locale);

    await notify({
      organizationId: input.organizationId,
      userIds: await whoHandlesBilling(input.organizationId, invoice.createdById),
      // Whoever pressed the button has just been told on screen.
      exceptUserId: input.userId ?? undefined,
      type: "PAYMENT_RECEIVED",
      title: `${money(outcome.amountCents)} paid online on ${invoice.number}`,
      body: outcome.settled
        ? "Paid in full."
        : `${money(outcome.balanceCents)} still outstanding.`,
      entityType: "invoice",
      entityId: invoice.id,
      actionUrl: `/invoices/${invoice.id}`,
    });

    await record({
      organizationId: input.organizationId,
      userId: input.userId,
      action: "payment.recorded",
      entityType: "INVOICE",
      entityId: invoice.id,
      summary: `${money(outcome.amountCents)} paid online through ${meta.label} on invoice ${invoice.number}${
        outcome.settled ? " — paid in full" : ""
      }`,
      metadata: {
        amountCents: outcome.amountCents,
        settled: outcome.settled,
        provider: processor.provider,
      },
    });

    // Only when the last of it is settled, as for a payment entered by hand:
    // three part-payments are one customer to thank, not three.
    if (outcome.settled) {
      await runEventWorkflows("invoice.paid", {
        organizationId: input.organizationId,
        entityType: "INVOICE",
        entityId: invoice.id,
        subject: invoice.client.displayName,
        document: invoice.number,
        clientId: invoice.clientId,
      });
    }
  }

  // Online payments reach QuickBooks like hand-entered ones. Outside a
  // request (a script) there is nothing to send them after; the morning run
  // picks them up.
  if (outcome.recorded > 0) {
    await sendToQuickBooksSoon(input.organizationId, { invoices: [input.invoiceId] }).catch(() => {});
  }

  return {
    ok: true,
    recorded: outcome.recorded,
    amountCents: outcome.amountCents,
    settled: outcome.settled,
    balanceCents: outcome.balanceCents,
    providerLabel: meta.label,
  };
}

// ------------------------------------------------------------------- sweep ---

export type PayLinkSweep = {
  /** Invoices the processor answered about. */
  checked: number;
  /** Payments written in. */
  recorded: number;
  /** Invoices the processor could not be asked about; tried again next run. */
  failed: number;
  /** Ran out of time with invoices left over. They go first next run. */
  stoppedEarly: boolean;
};

/**
 * Asks about every open invoice that carries a pay link.
 *
 * The safety net under PayPal's notices, and the only automatic check for
 * processors that send none here. Runs at the start of the morning run so the
 * automations after it see today's payments: chasing an invoice that was paid
 * last night is worse than not chasing at all.
 *
 * Longest-unchecked first, and stops when its time is up rather than taking the
 * rest of the run down with it. Whatever is left is the oldest-checked next
 * time, so nothing is starved however many links are open.
 */
export async function sweepPayLinks(
  options: { now?: Date; budgetMs?: number } = {},
): Promise<PayLinkSweep> {
  const now = options.now ?? new Date();
  const started = Date.now();
  const budgetMs = options.budgetMs ?? 20_000;
  const result: PayLinkSweep = { checked: 0, recorded: 0, failed: 0, stoppedEarly: false };

  const invoices = await prisma.invoice.findMany({
    where: {
      paymentRef: { not: null },
      status: { in: INVOICE_OPEN_STATUSES },
      balanceCents: { gt: 0 },
      organization: { isDemo: false },
    },
    select: { id: true, organizationId: true },
    orderBy: [{ paymentCheckedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: 500,
  });

  /** Per business: the processor to ask, or null for "skip its invoices". */
  const processors = new Map<string, ConnectedProcessor | null>();

  for (const invoice of invoices) {
    if (Date.now() - started > budgetMs) {
      result.stoppedEarly = true;
      break;
    }

    if (!processors.has(invoice.organizationId)) {
      processors.set(invoice.organizationId, await processorFor(invoice.organizationId, now));
    }
    const processor = processors.get(invoice.organizationId);
    if (!processor) continue;

    try {
      const outcome = await reconcileInvoice({
        organizationId: invoice.organizationId,
        invoiceId: invoice.id,
        userId: null,
        processor,
      });

      if (outcome.ok) {
        result.checked++;
        result.recorded += outcome.recorded;
      } else if (outcome.retry) {
        result.failed++;
        console.error(`[payments] could not check invoice ${invoice.id}: ${outcome.error}`);
      }
    } catch (error) {
      result.failed++;
      console.error(`[payments] checking invoice ${invoice.id} failed`, error);
    }
  }

  return result;
}

/**
 * The processor to ask on a business's behalf, when it should be asked at all.
 *
 * A locked business is skipped, as auto-pay skips it: its payments wait at the
 * processor and are written in when it reopens, by this same run. Also where a
 * PayPal business that has never been registered for notices gets registered,
 * since this is the one place every such business passes through.
 */
async function processorFor(organizationId: string, now: Date) {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org || org.isDemo || !entitlement(org, now).ok) return null;

  const processor = await resolveProcessor(organizationId);
  if (!processor || !PAYMENT_PROVIDER_META[processor.provider].reconciles) return null;

  if (processor.provider === "PAYPAL") {
    const hooked = await ensurePaypalWebhook(organizationId, processor);
    if (!hooked.ok && hooked.reason === "failed") {
      console.error(`[payments] could not register PayPal notices for ${organizationId}: ${hooked.error}`);
    }
  }

  return processor;
}

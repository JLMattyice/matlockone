"use server";

import { revalidatePath } from "next/cache";

import { saved, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { publicUrl } from "@/lib/messaging";
import { resolveProcessor } from "@/lib/payments/account";
import { PAYMENT_PROVIDER_META } from "@/lib/payments/catalog";
import { attachPaymentLink } from "@/lib/payments/link";
import { reconcileInvoice } from "@/lib/payments/reconcile";
import { notify, notifyClientByEmail } from "@/lib/notifications";
import { formatMoney } from "@/lib/money";
import { whoHandlesBilling } from "@/lib/recurring-invoices";
import { like } from "@/lib/search";

/** Invoices falling due inside this many days get a courtesy reminder. */
const DUE_SOON_DAYS = 3;

/**
 * How many invoices are asked about at once before reminding. Each is one
 * call to the processor; a handful at a time keeps a long list quick without
 * looking like a flood to the processor's rate limits.
 */
const CHECKS_AT_ONCE = 5;

const CANDIDATE_SELECT = {
  id: true,
  number: true,
  dueDate: true,
  balanceCents: true,
  amountPaidCents: true,
  publicToken: true,
  createdById: true,
  // Needed to attach a pay link to the reminder, and to know whether the one
  // already there still asks for the right amount.
  title: true,
  status: true,
  paymentUrl: true,
  paymentRef: true,
  paymentLinkCents: true,
  client: { select: { displayName: true, email: true } },
} as const;

/** The statuses a reminder is for; anything else has been paid or called off. */
const CHASEABLE = ["SENT", "VIEWED"];

/**
 * Chases unpaid invoices.
 *
 * Run from the Invoices screen today. It is written as a plain action with no
 * request-specific state so a scheduled task can call it on a timer later
 * without any change — the work is the same either way.
 *
 * Sending twice on the same day is prevented by checking the outbox rather than
 * a flag on the invoice, so the record of what was actually sent is the thing
 * that decides.
 *
 * Before anybody is chased, every invoice with a pay link is checked with the
 * processor. PayPal says when it is paid, but Stripe and Square are only
 * asked each morning, so without this a client who paid this afternoon would
 * be reminded this evening. An invoice the processor cannot answer for right
 * now is held back rather than chased on a guess: a day's delay costs little,
 * and a reminder for money already paid costs the business a customer's
 * goodwill.
 */
export async function sendInvoiceReminders(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("invoices:send");

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const dueSoonCutoff = new Date(
    startOfToday.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000,
  );

  const candidates = await prisma.invoice.findMany({
    where: {
      organizationId: org.id,
      status: { in: CHASEABLE },
      balanceCents: { gt: 0 },
      dueDate: { not: null, lte: dueSoonCutoff },
    },
    select: CANDIDATE_SELECT,
    orderBy: { dueDate: "asc" },
    take: 100,
  });

  if (candidates.length === 0) {
    return saved("Nothing to chase — no invoices are due or overdue.");
  }

  // Anything already chased today is skipped, so pressing the button twice
  // does not send the client two emails.
  const alreadySent = await prisma.outboxMessage.findMany({
    where: {
      organizationId: org.id,
      relatedType: "invoice",
      relatedId: { in: candidates.map((c) => c.id) },
      createdAt: { gte: startOfToday },
      // The only `like()` here that is not a user's search box. It matches
      // subjects this file wrote, which makes it look safe to leave
      // case-sensitive — right up until someone recapitalises the subject
      // below and every overdue client starts getting chased daily.
      subject: like("reminder"),
    },
    select: { relatedId: true },
  });
  const chased = new Set(alreadySent.map((m) => m.relatedId));

  const toChase = candidates.filter((invoice) => !chased.has(invoice.id));
  const skipped = candidates.length - toChase.length;

  const checked = await checkWithProcessor(org.id, toChase, user.id);

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);

  let sent = 0;
  const paidSince: string[] = [];
  const heldBack: string[] = [];
  const noPayLink: string[] = [];

  for (const candidate of toChase) {
    const verdict = checked.verdicts.get(candidate.id);

    if (verdict === "unreachable") {
      heldBack.push(candidate.number);
      continue;
    }

    // A payment found just now moved the balance, and perhaps settled it.
    const invoice =
      verdict === "changed"
        ? await prisma.invoice.findUnique({ where: { id: candidate.id }, select: CANDIDATE_SELECT })
        : candidate;

    if (!invoice || invoice.balanceCents <= 0 || !CHASEABLE.includes(invoice.status)) {
      paidSince.push(candidate.number);
      continue;
    }

    const overdue = invoice.dueDate! < startOfToday;
    const link = publicUrl(`/share/invoice/${invoice.publicToken}`);
    const due = invoice.dueDate!.toDateString();
    const owed = money(invoice.balanceCents);

    // A reminder that gives no way to pay is just a complaint. Reuses the link
    // the invoice already has, and asks for one otherwise — unless the one it
    // has asks for an amount that is no longer owed, which is left out rather
    // than sent.
    const linked = await attachPaymentLink(org, invoice);
    if (!linked.ok && linked.reason === "stale") noPayLink.push(invoice.number);
    const payLines = linked.ok ? [`Pay online: ${linked.url}`, ""] : [];

    // Part-paid: say what is left, so nobody reads the original total as
    // what they still owe.
    const partPaid = invoice.amountPaidCents > 0;
    const owing = overdue
      ? partPaid
        ? `Invoice ${invoice.number} was due on ${due}, and ${owed} of it is still outstanding.`
        : `Invoice ${invoice.number} for ${owed} was due on ${due} and is still outstanding.`
      : partPaid
        ? `A reminder that invoice ${invoice.number} is due on ${due}, with ${owed} still to pay.`
        : `A reminder that invoice ${invoice.number} for ${owed} is due on ${due}.`;

    await notifyClientByEmail({
      organizationId: org.id,
      to: invoice.client.email,
      toName: invoice.client.displayName,
      subject: overdue
        ? `Overdue reminder — invoice ${invoice.number}`
        : `Payment reminder — invoice ${invoice.number}`,
      body: [
        `Hi ${invoice.client.displayName},`,
        "",
        owing,
        "",
        ...payLines,
        `View it online: ${link}`,
        "",
        "If you have already sent payment, please ignore this.",
        "",
        "Thank you,",
        org.name,
      ].join("\n"),
      relatedType: "invoice",
      relatedId: invoice.id,
      createdById: user.id,
    });

    await notify({
      organizationId: org.id,
      // Whoever raised it, or everyone who sends invoices once they've gone.
      userIds: await whoHandlesBilling(org.id, invoice.createdById),
      exceptUserId: user.id,
      type: overdue ? "INVOICE_OVERDUE" : "INVOICE_DUE",
      title: overdue
        ? `${invoice.number} is overdue`
        : `${invoice.number} is due soon`,
      body: `${owed} from ${invoice.client.displayName}`,
      entityType: "invoice",
      entityId: invoice.id,
      actionUrl: `/invoices/${invoice.id}`,
    });

    sent++;
  }

  revalidatePath("/invoices");
  revalidatePath("/payments");
  revalidatePath("/", "layout");

  return saved(
    summarise({
      sent,
      skipped,
      paidSince,
      heldBack,
      noPayLink,
      processorLabel: checked.processorLabel,
    }),
  );
}

type Verdict = "changed" | "unreachable";

/**
 * Asks the processor about every invoice it has a pay link for.
 *
 * "changed": a payment was found and written in, so the invoice is read
 * again before deciding. "unreachable": the processor could not answer, and
 * the invoice is held back. Anything else — nothing new, or a link the
 * processor cannot report on — goes ahead as it was.
 */
async function checkWithProcessor(
  organizationId: string,
  invoices: { id: string; paymentRef: string | null }[],
  userId: string,
): Promise<{ verdicts: Map<string, Verdict>; processorLabel: string | null }> {
  const verdicts = new Map<string, Verdict>();

  // A link with no processor-side request (a pasted link, Clover) cannot be
  // asked about; there is nothing to check before chasing.
  const linked = invoices.filter((invoice) => invoice.paymentRef);
  if (linked.length === 0) return { verdicts, processorLabel: null };

  const processor = await resolveProcessor(organizationId);
  if (!processor) return { verdicts, processorLabel: null };

  const meta = PAYMENT_PROVIDER_META[processor.provider];
  if (!meta.reconciles) return { verdicts, processorLabel: meta.label };

  for (let start = 0; start < linked.length; start += CHECKS_AT_ONCE) {
    await Promise.all(
      linked.slice(start, start + CHECKS_AT_ONCE).map(async (invoice) => {
        try {
          const outcome = await reconcileInvoice({
            organizationId,
            invoiceId: invoice.id,
            userId,
            processor,
          });
          if (!outcome.ok) {
            if (outcome.retry) verdicts.set(invoice.id, "unreachable");
          } else if (outcome.recorded > 0) {
            verdicts.set(invoice.id, "changed");
          }
        } catch (error) {
          // Not knowing is not the same as knowing it is unpaid.
          console.error(`[reminders] could not check invoice ${invoice.id}`, error);
          verdicts.set(invoice.id, "unreachable");
        }
      }),
    );
  }

  return { verdicts, processorLabel: meta.label };
}

/** One sentence per thing that happened, most important first. */
function summarise(result: {
  sent: number;
  skipped: number;
  paidSince: string[];
  heldBack: string[];
  noPayLink: string[];
  processorLabel: string | null;
}): string {
  const parts: string[] = [];
  const list = (numbers: string[]) => numbers.join(", ");

  if (result.sent > 0) {
    parts.push(`${result.sent} reminder${result.sent === 1 ? "" : "s"} sent.`);
  }
  if (result.paidSince.length > 0) {
    parts.push(
      `Not chased, because ${result.paidSince.length === 1 ? "it has" : "they have"} been paid: ${list(result.paidSince)}.`,
    );
  }
  if (result.heldBack.length > 0) {
    parts.push(
      `Held back, because ${result.processorLabel ?? "the payment processor"} couldn’t say whether ${
        result.heldBack.length === 1 ? "it was" : "they were"
      } paid — try again shortly: ${list(result.heldBack)}.`,
    );
  }
  if (result.noPayLink.length > 0) {
    parts.push(
      `Sent without a Pay now link, because the link asks for an old amount — replace it on the invoice: ${list(result.noPayLink)}.`,
    );
  }
  if (result.skipped > 0) {
    parts.push(`${result.skipped} already chased today.`);
  }

  return parts.length > 0 ? parts.join(" ") : "Nothing to chase.";
}

export async function reminderCandidateCount(): Promise<number> {
  const { org } = await requirePermission("invoices:read");

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const cutoff = new Date(
    startOfToday.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000,
  );

  return prisma.invoice.count({
    where: {
      organizationId: org.id,
      status: { in: CHASEABLE },
      balanceCents: { gt: 0 },
      dueDate: { not: null, lte: cutoff },
    },
  });
}

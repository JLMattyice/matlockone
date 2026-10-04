import "server-only";

import { prisma } from "./db";
import { BP_DIVISOR, computeTotals, depositCentsFor, formatMoney } from "./money";
import { allocateNumber } from "./numbering";
import { formatIn, parseDateTimeLocal } from "./time-zone";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Billing a job in parts against its estimate.
 *
 * The owner chose deposits and progress invoices (not retainage or change
 * orders). A deposit is asked for on the estimate and billed when it is
 * accepted; progress invoices bill a share of the estimate as the work goes;
 * the final invoice carries the whole estimate — every line, the discount
 * and the tax — less what the earlier stages billed.
 *
 * Earlier stages are single, non-taxable lines for a share of the estimate's
 * total, tax included. The credit on the final invoice is taken off after
 * tax, so the final invoice's tax is the whole job's tax, which is what a
 * tax return wants, and the three invoices together come to the estimate's
 * total to the cent.
 */

export type BillingStage = "DEPOSIT" | "PROGRESS" | "FINAL";

type Tx = Prisma.TransactionClient | typeof prisma;

const PRIOR_STAGES = ["DEPOSIT", "PROGRESS"];

/** What the deposit and progress invoices on an estimate have billed. */
export async function priorBilling(
  tx: Tx,
  estimateId: string,
  options: { excludeInvoiceId?: string } = {},
): Promise<{ cents: number; label: string | null; invoices: { id: string; number: string; totalCents: number }[] }> {
  const invoices = await tx.invoice.findMany({
    where: {
      estimateId,
      billingStage: { in: PRIOR_STAGES },
      status: { not: "CANCELLED" },
      ...(options.excludeInvoiceId ? { id: { not: options.excludeInvoiceId } } : {}),
    },
    select: { id: true, number: true, totalCents: true },
    orderBy: { createdAt: "asc" },
  });
  const cents = invoices.reduce((sum, invoice) => sum + invoice.totalCents, 0);
  return {
    cents,
    label: invoices.length ? `Previously billed (${invoices.map((i) => i.number).join(", ")})` : null,
    invoices,
  };
}

/**
 * The final invoice that already counts this deposit or progress invoice, if
 * any. The final takes the earlier stages off as they stood when it was made,
 * so one of them cancelled, reinstated, edited or deleted afterwards would
 * leave the final billing the wrong amount. Such a change waits until the
 * final invoice is cancelled.
 */
export async function finalCounting(
  tx: Tx,
  invoice: { billingStage: string | null; estimateId: string | null },
): Promise<{ id: string; number: string } | null> {
  if (!invoice.estimateId || !invoice.billingStage || !PRIOR_STAGES.includes(invoice.billingStage)) {
    return null;
  }
  return tx.invoice.findFirst({
    where: { estimateId: invoice.estimateId, billingStage: "FINAL", status: { not: "CANCELLED" } },
    select: { id: true, number: true },
  });
}

export type EstimateBilling = {
  totalCents: number;
  depositCents: number;
  billedCents: number;
  remainingCents: number;
  deposit: {
    id: string;
    number: string;
    status: string;
    totalCents: number;
    balanceCents: number;
    publicToken: string;
  } | null;
  final: { id: string; number: string; status: string } | null;
  stages: { id: string; number: string; stage: string; status: string; totalCents: number }[];
};

/** Where an estimate's billing stands, for its page and the customer's. */
export async function estimateBilling(estimateId: string): Promise<EstimateBilling | null> {
  const estimate = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: {
      totalCents: true,
      depositCents: true,
      invoices: {
        where: { billingStage: { not: null } },
        select: {
          id: true,
          number: true,
          billingStage: true,
          status: true,
          totalCents: true,
          balanceCents: true,
          publicToken: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!estimate) return null;

  const live = estimate.invoices.filter((invoice) => invoice.status !== "CANCELLED");
  const billedCents = live
    .filter((invoice) => PRIOR_STAGES.includes(invoice.billingStage!))
    .reduce((sum, invoice) => sum + invoice.totalCents, 0);
  const deposit = live.find((invoice) => invoice.billingStage === "DEPOSIT") ?? null;
  const final = live.find((invoice) => invoice.billingStage === "FINAL") ?? null;

  return {
    totalCents: estimate.totalCents,
    depositCents: estimate.depositCents,
    billedCents: final ? estimate.totalCents : billedCents,
    remainingCents: final ? 0 : Math.max(estimate.totalCents - billedCents, 0),
    deposit: deposit
      ? {
          id: deposit.id,
          number: deposit.number,
          status: deposit.status,
          totalCents: deposit.totalCents,
          balanceCents: deposit.balanceCents,
          publicToken: deposit.publicToken,
        }
      : null,
    final: final ? { id: final.id, number: final.number, status: final.status } : null,
    stages: estimate.invoices.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      stage: invoice.billingStage!,
      status: invoice.status,
      totalCents: invoice.totalCents,
    })),
  };
}

type EstimateForBilling = {
  id: string;
  organizationId: string;
  number: string;
  title: string | null;
  clientId: string;
  addressId: string | null;
  convertedJobId: string | null;
  totalCents: number;
  depositType: string;
  depositValue: number;
  discountType: string;
  discountValue: number;
  taxRateBp: number;
  lineItems: {
    kind: string;
    name: string;
    description: string | null;
    quantity: number;
    unit: string;
    unitPriceCents: number;
    taxable: boolean;
    sortOrder: number;
  }[];
};

type OrgForBilling = {
  id: string;
  currency: string;
  locale: string;
  labelEstimateSingular: string;
  defaultPaymentTermsDays: number;
  invoiceFooter: string | null;
  timeZone: string;
};

export type StageRequest =
  | { stage: "DEPOSIT" }
  | { stage: "PROGRESS"; percentBp?: number; amountCents?: number }
  | { stage: "FINAL" };

export class BillingRefused extends Error {}

/**
 * The end of the due day in the business's own time zone. A deposit is due
 * the day it is asked for, and an invoice judged overdue the moment its due
 * time passes must not be overdue the second it is made.
 */
function dueDate(issueDate: Date, days: number, zone: string) {
  const day = formatIn(new Date(issueDate.getTime() + days * 24 * 60 * 60 * 1000), "yyyy-MM-dd", zone);
  return parseDateTimeLocal(`${day}T23:59`, zone) ?? issueDate;
}

/**
 * Makes one stage's invoice for an accepted estimate. `sent` makes it ready
 * for the customer straight away (a deposit asked for at the moment they
 * accept); otherwise it is a draft for the office to look over and send.
 */
export async function createStageInvoice(
  tx: Prisma.TransactionClient,
  input: {
    org: OrgForBilling;
    estimate: EstimateForBilling;
    request: StageRequest;
    createdById: string | null;
    sent?: boolean;
    now?: Date;
  },
): Promise<{ id: string; number: string }> {
  const { org, estimate, request } = input;
  const now = input.now ?? new Date();
  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const label = `${org.labelEstimateSingular} ${estimate.number}`;

  // Holds the estimate's row for the rest of the transaction, so two stages
  // made at once — a double-clicked button, the customer's deposit racing the
  // office — are made one after the other, and the second sees the first.
  await tx.estimate.update({ where: { id: estimate.id }, data: { updatedAt: now } });

  const existing = await tx.invoice.findMany({
    where: { estimateId: estimate.id, billingStage: { not: null }, status: { not: "CANCELLED" } },
    select: { billingStage: true },
  });
  if (existing.some((invoice) => invoice.billingStage === "FINAL")) {
    throw new BillingRefused("The final invoice for this has already been made.");
  }

  const prior = await priorBilling(tx, estimate.id);
  const remaining = Math.max(estimate.totalCents - prior.cents, 0);

  let lines: EstimateForBilling["lineItems"];
  let title: string;
  let discount = { type: "NONE", value: 0 };
  let taxRateBp = 0;
  let creditCents = 0;
  let creditLabel: string | null = null;

  if (request.stage === "FINAL") {
    lines = estimate.lineItems;
    title = estimate.title ?? label;
    discount = { type: estimate.discountType, value: estimate.discountValue };
    taxRateBp = estimate.taxRateBp;
    creditCents = prior.cents;
    creditLabel = prior.label;
  } else {
    let amount: number;
    let description: string;

    if (request.stage === "DEPOSIT") {
      if (existing.some((invoice) => invoice.billingStage === "DEPOSIT")) {
        throw new BillingRefused("A deposit has already been billed for this.");
      }
      amount = depositCentsFor(estimate.totalCents, estimate.depositType, estimate.depositValue);
      if (amount <= 0) throw new BillingRefused("This asks for no deposit.");
      description =
        estimate.depositType === "PERCENT"
          ? `Deposit — ${estimate.depositValue / 100}% of ${label}`
          : `Deposit on ${label}`;
    } else {
      amount =
        request.amountCents ??
        Math.round((estimate.totalCents * (request.percentBp ?? 0)) / BP_DIVISOR);
      if (amount <= 0) throw new BillingRefused("Enter an amount or a percentage to bill.");
      if (amount > remaining) {
        throw new BillingRefused(`Only ${money(remaining)} is left to bill on this.`);
      }
      const share = Math.round((amount / Math.max(estimate.totalCents, 1)) * 1000) / 10;
      description = `Progress billing — ${share}% of ${label}`;
    }

    if (amount > remaining) amount = remaining;
    lines = [
      {
        kind: "OTHER",
        name: description,
        description: `${money(estimate.totalCents)} in all; ${money(prior.cents)} billed before this.`,
        quantity: 1,
        unit: "ea",
        unitPriceCents: amount,
        // A share of a total that already includes tax.
        taxable: false,
        sortOrder: 0,
      },
    ];
    title = description;
  }

  const totals = computeTotals({
    lineItems: lines.map((line) => ({
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      taxable: line.taxable,
    })),
    discountType: discount.type as "NONE" | "PERCENT" | "FIXED",
    discountValue: discount.value,
    taxRateBp,
    creditCents,
  });

  const number = await allocateNumber(tx, org.id, "invoice");
  const created = await tx.invoice.create({
    data: {
      organizationId: org.id,
      number,
      title,
      status: input.sent ? "SENT" : "DRAFT",
      sentAt: input.sent ? now : null,
      clientId: estimate.clientId,
      addressId: estimate.addressId,
      jobId: estimate.convertedJobId,
      estimateId: estimate.id,
      billingStage: request.stage,
      issueDate: now,
      paymentTermsDays: request.stage === "DEPOSIT" ? 0 : org.defaultPaymentTermsDays,
      dueDate: dueDate(now, request.stage === "DEPOSIT" ? 0 : org.defaultPaymentTermsDays, org.timeZone),
      subtotalCents: totals.subtotalCents,
      discountType: discount.type,
      discountValue: discount.value,
      discountCents: totals.discountCents,
      taxRateBp,
      taxCents: totals.taxCents,
      creditCents: totals.creditCents,
      creditLabel,
      totalCents: totals.totalCents,
      amountPaidCents: 0,
      balanceCents: totals.totalCents,
      terms: org.invoiceFooter,
      createdById: input.createdById,
      lineItems: {
        create: lines.map((line, i) => ({
          kind: line.kind,
          name: line.name,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPriceCents: line.unitPriceCents,
          taxable: line.taxable,
          totalCents: totals.lineTotalsCents[i],
          sortOrder: i,
        })),
      },
    },
    select: { id: true, number: true },
  });
  return created;
}

/** The estimate and business fields createStageInvoice needs. */
export const ESTIMATE_BILLING_SELECT = {
  id: true,
  organizationId: true,
  number: true,
  title: true,
  status: true,
  clientId: true,
  addressId: true,
  convertedJobId: true,
  totalCents: true,
  depositType: true,
  depositValue: true,
  depositCents: true,
  discountType: true,
  discountValue: true,
  taxRateBp: true,
  lineItems: {
    orderBy: { sortOrder: "asc" as const },
    select: {
      kind: true,
      name: true,
      description: true,
      quantity: true,
      unit: true,
      unitPriceCents: true,
      taxable: true,
      sortOrder: true,
    },
  },
} as const;

export const ORG_BILLING_SELECT = {
  id: true,
  currency: true,
  locale: true,
  labelEstimateSingular: true,
  defaultPaymentTermsDays: true,
  invoiceFooter: true,
  timeZone: true,
} as const;

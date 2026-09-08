"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import {
  DISCOUNT_TYPES,
  LINE_ITEM_KINDS,
  PAYMENT_METHODS,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { recalculateInvoice } from "@/lib/invoice-balance";
import { publicUrl, sendMessage } from "@/lib/messaging";
import { attachPaymentLink } from "@/lib/payments/link";
import { invoicePdfFor } from "@/lib/pdf/invoice-document";
import { notify, notifyClientByEmail } from "@/lib/notifications";
import { computeTotals, formatMoney, parseMoneyToCents } from "@/lib/money";
import { allocateNumber } from "@/lib/numbering";
import type { Prisma } from "@/generated/prisma/client";

// ------------------------------------------------------------------ schema ---

const lineItemSchema = z.object({
  kind: z.enum(LINE_ITEM_KINDS),
  name: z.string().trim().min(1, "Every line needs a description."),
  description: z.string().trim().nullish(),
  quantity: z.coerce.number().min(0).max(1_000_000),
  unit: z.string().trim().min(1).max(16).default("ea"),
  unitPriceCents: z.coerce.number().int().min(-100_000_000).max(100_000_000),
  taxable: z.boolean(),
});

const invoiceSchema = z.object({
  clientId: z.string().min(1, "Choose a client."),
  addressId: z.string().trim().nullish(),
  jobId: z.string().trim().nullish(),
  title: z.string().trim().nullish(),
  issueDate: z.string().trim().min(1, "Pick an issue date."),
  paymentTermsDays: z.coerce.number().int().min(0).max(365),
  dueDate: z.string().trim().nullish(),
  discountType: z.enum(DISCOUNT_TYPES),
  discountValue: z.coerce.number().int().min(0).max(100_000_000),
  taxRateBp: z.coerce.number().int().min(0).max(10_000),
  notes: z.string().trim().nullish(),
  terms: z.string().trim().nullish(),
  lineItems: z.array(lineItemSchema).min(1, "Add at least one line."),
});

type InvoiceInput = z.infer<typeof invoiceSchema>;

function parseInvoiceForm(formData: FormData) {
  let lineItems: unknown = [];
  const raw = formData.get("lineItemsJson");
  if (typeof raw === "string" && raw.trim()) {
    try {
      lineItems = JSON.parse(raw);
    } catch {
      lineItems = [];
    }
  }

  return invoiceSchema.safeParse({
    clientId: formData.get("clientId"),
    addressId: text(formData, "addressId"),
    jobId: text(formData, "jobId"),
    title: text(formData, "title"),
    issueDate: formData.get("issueDate"),
    paymentTermsDays: formData.get("paymentTermsDays") ?? 30,
    dueDate: text(formData, "dueDate"),
    discountType: formData.get("discountType") ?? "NONE",
    discountValue: formData.get("discountValue") ?? 0,
    taxRateBp: formData.get("taxRateBp") ?? 0,
    notes: text(formData, "notes"),
    terms: text(formData, "terms"),
    lineItems,
  });
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Recomputed server-side; the editor's running total is feedback only. */
function totalsFor(input: InvoiceInput) {
  return computeTotals({
    lineItems: input.lineItems.map((item) => ({
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      taxable: item.taxable,
    })),
    discountType: input.discountType,
    discountValue: input.discountValue,
    taxRateBp: input.taxRateBp,
  });
}

function lineItemRows(input: InvoiceInput, lineTotals: number[]) {
  return input.lineItems.map((item, i) => ({
    kind: item.kind,
    name: item.name,
    description: item.description ?? null,
    quantity: item.quantity,
    unit: item.unit,
    unitPriceCents: item.unitPriceCents,
    taxable: item.taxable,
    totalCents: lineTotals[i],
    sortOrder: i,
  }));
}

async function resolveRefs(
  input: InvoiceInput,
  organizationId: string,
): Promise<{ clientId: string; addressId: string | null; jobId: string | null } | null> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, organizationId },
    select: { id: true },
  });
  if (!client) return null;

  const address = input.addressId
    ? await prisma.address.findFirst({
        where: { id: input.addressId, organizationId, clientId: client.id },
        select: { id: true },
      })
    : null;

  const job = input.jobId
    ? await prisma.job.findFirst({
        where: { id: input.jobId, organizationId },
        select: { id: true },
      })
    : null;

  return {
    clientId: client.id,
    addressId: address?.id ?? null,
    jobId: job?.id ?? null,
  };
}

// ------------------------------------------------------------------ create ---

export async function createInvoice(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("invoices:write");

  const parsed = parseInvoiceForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const refs = await resolveRefs(input, org.id);
  if (!refs) return { ok: false, fieldErrors: { clientId: "Choose a client." } };

  const issueDate = parseDate(input.issueDate) ?? new Date();
  const totals = totalsFor(input);

  const invoiceId = await prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<string> => {
      const number = await allocateNumber(tx, org.id, "invoice");

      const created: { id: string } = await tx.invoice.create({
        data: {
          organizationId: org.id,
          number,
          title: input.title ?? null,
          status: "DRAFT",
          clientId: refs.clientId,
          addressId: refs.addressId,
          jobId: refs.jobId,
          issueDate,
          paymentTermsDays: input.paymentTermsDays,
          dueDate:
            parseDate(input.dueDate) ??
            new Date(
              issueDate.getTime() +
                input.paymentTermsDays * 24 * 60 * 60 * 1000,
            ),
          subtotalCents: totals.subtotalCents,
          discountType: input.discountType,
          discountValue: input.discountValue,
          discountCents: totals.discountCents,
          taxRateBp: input.taxRateBp,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
          amountPaidCents: 0,
          balanceCents: totals.totalCents,
          notes: input.notes ?? null,
          terms: input.terms ?? org.invoiceFooter,
          createdById: user.id,
          lineItems: { create: lineItemRows(input, totals.lineTotalsCents) },
        },
        select: { id: true },
      });

      return created.id;
    },
  );

  revalidatePath("/invoices");
  redirect(`/invoices/${invoiceId}`);
}

export async function updateInvoice(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("invoices:write");

  const id = text(formData, "id");
  if (!id) return failed("Missing invoice id.");

  const existing = await prisma.invoice.findFirst({
    where: { id, organizationId: org.id },
    select: { status: true, amountPaidCents: true },
  });
  if (!existing) return failed("That invoice no longer exists.");

  if (existing.status === "CANCELLED") {
    return failed("This invoice has been cancelled and can no longer be edited.");
  }

  // Changing the amount of an invoice that has already been part-paid would
  // silently rewrite what the client agreed to owe.
  if (existing.amountPaidCents > 0) {
    return failed(
      "Payments have already been recorded against this invoice. Remove them first, or issue a credit as a new invoice.",
    );
  }

  const parsed = parseInvoiceForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const refs = await resolveRefs(input, org.id);
  if (!refs) return { ok: false, fieldErrors: { clientId: "Choose a client." } };

  const issueDate = parseDate(input.issueDate) ?? new Date();
  const totals = totalsFor(input);

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.invoice.update({
      where: { id },
      data: {
        title: input.title ?? null,
        clientId: refs.clientId,
        addressId: refs.addressId,
        jobId: refs.jobId,
        issueDate,
        paymentTermsDays: input.paymentTermsDays,
        dueDate:
          parseDate(input.dueDate) ??
          new Date(
            issueDate.getTime() + input.paymentTermsDays * 24 * 60 * 60 * 1000,
          ),
        subtotalCents: totals.subtotalCents,
        discountType: input.discountType,
        discountValue: input.discountValue,
        discountCents: totals.discountCents,
        taxRateBp: input.taxRateBp,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        notes: input.notes ?? null,
        terms: input.terms ?? null,
      },
    });

    await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
    await tx.invoiceLineItem.createMany({
      data: lineItemRows(input, totals.lineTotalsCents).map((row) => ({
        ...row,
        invoiceId: id,
      })),
    });

    // The total moved, so the cached balance has to follow it.
    await recalculateInvoice(tx, id);
  });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${id}`);
  return saved("Invoice updated.");
}

/**
 * Bills a completed job.
 *
 * Materials come across at their recorded cost and labor at each person's
 * logged rate, as a starting point the office reviews before sending — the job
 * records what was *spent*, which is not automatically what is charged.
 */
export async function createInvoiceFromJob(formData: FormData) {
  const { user, org } = await requirePermission("invoices:write");

  const jobId = String(formData.get("jobId") ?? "");
  if (!jobId) return;

  const job = await prisma.job.findFirst({
    where: { id: jobId, organizationId: org.id },
    include: {
      materials: { where: { billable: true } },
      timeEntries: {
        where: { billable: true },
        include: { user: { select: { id: true, name: true } } },
      },
      client: { select: { id: true, taxExempt: true } },
    },
  });
  if (!job || !job.clientId) return;

  type Draft = {
    kind: string;
    name: string;
    description: string | null;
    quantity: number;
    unit: string;
    unitPriceCents: number;
    taxable: boolean;
  };

  const drafts: Draft[] = [];

  for (const material of job.materials) {
    drafts.push({
      kind: "MATERIAL",
      name: material.name,
      description: material.description,
      quantity: material.quantity,
      unit: material.unit,
      unitPriceCents: material.unitCostCents,
      taxable: true,
    });
  }

  // One labor line per person, so the invoice reads "8 hrs — Priya" rather
  // than a row for every clock-in.
  const byPerson = new Map<string, { name: string; minutes: number; rate: number }>();
  for (const entry of job.timeEntries) {
    const current = byPerson.get(entry.userId);
    if (current) {
      current.minutes += entry.minutes;
      current.rate = Math.max(current.rate, entry.hourlyRateCents);
    } else {
      byPerson.set(entry.userId, {
        name: entry.user.name,
        minutes: entry.minutes,
        rate: entry.hourlyRateCents,
      });
    }
  }

  for (const person of byPerson.values()) {
    if (person.minutes === 0) continue;
    drafts.push({
      kind: "LABOR",
      name: `Labor — ${person.name}`,
      description: null,
      quantity: Math.round((person.minutes / 60) * 100) / 100,
      unit: "hr",
      unitPriceCents: person.rate,
      taxable: false,
    });
  }

  if (drafts.length === 0) {
    drafts.push({
      kind: "SERVICE",
      name: job.title,
      description: job.description,
      quantity: 1,
      unit: "job",
      unitPriceCents: 0,
      taxable: true,
    });
  }

  const taxRateBp = job.client?.taxExempt ? 0 : org.defaultTaxRateBp;
  const totals = computeTotals({
    lineItems: drafts.map((line) => ({
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      taxable: line.taxable,
    })),
    discountType: "NONE",
    discountValue: 0,
    taxRateBp,
  });

  const issueDate = new Date();

  const invoiceId = await prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<string> => {
      const number = await allocateNumber(tx, org.id, "invoice");

      const created: { id: string } = await tx.invoice.create({
        data: {
          organizationId: org.id,
          number,
          title: job.title,
          status: "DRAFT",
          clientId: job.clientId!,
          addressId: job.addressId,
          jobId: job.id,
          issueDate,
          paymentTermsDays: org.defaultPaymentTermsDays,
          dueDate: new Date(
            issueDate.getTime() +
              org.defaultPaymentTermsDays * 24 * 60 * 60 * 1000,
          ),
          subtotalCents: totals.subtotalCents,
          discountType: "NONE",
          discountValue: 0,
          discountCents: totals.discountCents,
          taxRateBp,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
          amountPaidCents: 0,
          balanceCents: totals.totalCents,
          terms: org.invoiceFooter,
          createdById: user.id,
          lineItems: {
            create: drafts.map((line, i) => ({
              ...line,
              totalCents: totals.lineTotalsCents[i],
              sortOrder: i,
            })),
          },
        },
        select: { id: true },
      });

      return created.id;
    },
  );

  revalidatePath("/invoices");
  revalidatePath(`/jobs/${job.id}`);
  redirect(`/invoices/${invoiceId}`);
}

// -------------------------------------------------------------------- send ---

export async function sendInvoice(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("invoices:send");

  const id = String(formData.get("id") ?? "");
  if (!id) return failed("Missing invoice id.");

  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId: org.id },
    include: {
      client: { select: { displayName: true, email: true } },
      _count: { select: { lineItems: true } },
    },
  });
  if (!invoice) return failed("That invoice no longer exists.");
  if (invoice._count.lineItems === 0) {
    return failed("Add at least one line before sending.");
  }
  if (invoice.status === "CANCELLED") {
    return failed("This invoice has been cancelled.");
  }

  const to = text(formData, "email") ?? invoice.client.email;
  if (!to) {
    return {
      ok: false,
      fieldErrors: {
        email: "This client has no email address. Add one, or enter one here.",
      },
    };
  }

  const link = publicUrl(`/share/invoice/${invoice.publicToken}`);
  const amount = formatMoney(invoice.balanceCents, org.currency, org.locale);

  // The Pay now link goes first when there is one. It is hosted by the
  // processor, so unlike the share link above it works from anywhere — which
  // on the desktop build is often the only address the client can open.
  //
  // Attached here rather than left to a separate button. An invoice email that
  // cannot be paid from is most of the point of sending it, and remembering to
  // press "Add pay link" first is not a workflow anybody keeps up.
  //
  // A processor that is not connected, or an invoice in a state that cannot
  // take money, is not an error: the invoice still goes out, just without the
  // line. Only a processor that was asked and refused is worth reporting.
  const linked =
    invoice.status === "DRAFT"
      ? // Sending is what promotes a draft to SENT, a few lines below. Ask for
        // the link as though that had already happened.
        await attachPaymentLink(org, { ...invoice, status: "SENT" })
      : await attachPaymentLink(org, invoice);

  const payUrl = linked.ok ? linked.url : null;
  const payLines = payUrl ? [`Pay online: ${payUrl}`, ""] : [];

  // The invoice itself, so the client keeps the document rather than only a
  // link — and so it is still readable in their inbox years later, when no
  // link is going to resolve. Built after the pay link is attached, so the
  // PDF carries that too.
  //
  // A failure here must not stop the invoice going out. A plain email with a
  // pay link is still a working invoice; sending nothing would be far worse
  // than sending it without the file.
  let attachments;
  try {
    const document = await invoicePdfFor(org, invoice.id);
    if (document) {
      attachments = [
        {
          filename: document.filename,
          content: document.bytes,
          contentType: "application/pdf",
        },
      ];
    }
  } catch {
    attachments = undefined;
  }

  const result = await sendMessage({
    organizationId: org.id,
    channel: "EMAIL",
    to,
    toName: invoice.client.displayName,
    attachments,
    subject: `Invoice ${invoice.number} from ${org.name}`,
    body: [
      `Hi ${invoice.client.displayName},`,
      "",
      `Invoice ${invoice.number} for ${amount} is attached.`,
      invoice.dueDate
        ? `Payment is due by ${invoice.dueDate.toDateString()}.`
        : "",
      "",
      ...payLines,
      `View it online: ${link}`,
      "",
      "Thank you,",
      org.name,
    ].join("\n"),
    relatedType: "invoice",
    relatedId: invoice.id,
    createdById: user.id,
  });

  if (!result.ok) return failed(result.error ?? "Could not send that invoice.");

  await prisma.invoice.update({
    where: { id },
    data: {
      status: invoice.status === "DRAFT" ? "SENT" : invoice.status,
      sentAt: invoice.sentAt ?? new Date(),
    },
  });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${id}`);

  // Marked sent either way, but never described as delivered when it was not.
  if (!result.delivered) {
    return saved(
      `Marked as sent and saved to the outbox. Connect an email account under Settings → Email to deliver it to ${to}.`,
    );
  }

  // The invoice went out. If the processor refused a link, say so plainly
  // rather than letting the customer assume the email carried one.
  if (!linked.ok && linked.reason === "failed") {
    return saved(
      `Sent to ${to}, but without a Pay now link — ${linked.error}`,
    );
  }

  return saved(payUrl ? `Sent to ${to}, with a Pay now link.` : `Sent to ${to}.`);
}

// ---------------------------------------------------------------- payments ---

const paymentSchema = z.object({
  invoiceId: z.string().min(1),
  amount: z.string().trim().min(1, "Enter an amount."),
  method: z.enum(PAYMENT_METHODS),
  receivedAt: z.string().trim().min(1, "Pick a date."),
  reference: z.string().trim().nullish(),
  notes: z.string().trim().nullish(),
});

export async function recordPayment(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("payments:record");

  const parsed = paymentSchema.safeParse({
    invoiceId: formData.get("invoiceId"),
    amount: formData.get("amount"),
    method: formData.get("method") ?? "CASH",
    receivedAt: formData.get("receivedAt"),
    reference: text(formData, "reference"),
    notes: text(formData, "notes"),
  });

  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;

  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: org.id },
    select: {
      id: true,
      number: true,
      clientId: true,
      status: true,
      balanceCents: true,
      createdById: true,
      client: { select: { displayName: true, email: true } },
    },
  });
  if (!invoice) return failed("That invoice no longer exists.");
  if (invoice.status === "CANCELLED") {
    return failed("This invoice has been cancelled.");
  }
  if (invoice.status === "DRAFT") {
    return failed("Send the invoice before recording a payment against it.");
  }

  const amountCents = parseMoneyToCents(input.amount);
  if (amountCents === null || amountCents <= 0) {
    return { ok: false, fieldErrors: { amount: "Enter an amount above zero." } };
  }

  const receivedAt = parseDate(input.receivedAt);
  if (!receivedAt) {
    return { ok: false, fieldErrors: { receivedAt: "Pick a valid date." } };
  }

  const result = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.payment.create({
        data: {
          organizationId: org.id,
          invoiceId: invoice.id,
          clientId: invoice.clientId,
          amountCents,
          method: input.method,
          receivedAt,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          recordedById: user.id,
        },
      });

      return recalculateInvoice(tx, invoice.id);
    },
  );

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);

  // Whoever raised the invoice hears that it was paid; the client gets a
  // receipt. Both are best-effort and must not undo the recorded payment.
  await notify({
    organizationId: org.id,
    userIds: invoice.createdById ? [invoice.createdById] : [],
    exceptUserId: user.id,
    type: "PAYMENT_RECEIVED",
    title: `${money(amountCents)} received on ${invoice.number}`,
    body: result?.settled
      ? "Paid in full."
      : `${money(result?.balanceCents ?? 0)} still outstanding.`,
    entityType: "invoice",
    entityId: invoice.id,
    actionUrl: `/invoices/${invoice.id}`,
  });

  await notifyClientByEmail({
    organizationId: org.id,
    to: invoice.client?.email,
    toName: invoice.client?.displayName ?? "there",
    subject: `Payment received — ${invoice.number}`,
    body: [
      `Hi ${invoice.client?.displayName ?? "there"},`,
      "",
      `We have recorded your payment of ${money(amountCents)} against invoice ${invoice.number}.`,
      result?.settled
        ? "That settles it in full — thank you."
        : `${money(result?.balanceCents ?? 0)} remains outstanding.`,
      "",
      "Thank you,",
      org.name,
    ].join("\n"),
    relatedType: "invoice",
    relatedId: invoice.id,
    createdById: user.id,
  });

  revalidatePath("/invoices");
  revalidatePath("/payments");
  revalidatePath(`/invoices/${invoice.id}`);

  return saved(
    result?.settled
      ? `${money(amountCents)} recorded — invoice paid in full.`
      : `${money(amountCents)} recorded. ${money(result?.balanceCents ?? 0)} still outstanding.`,
  );
}

export async function deletePayment(formData: FormData) {
  const { org } = await requirePermission("payments:record");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const payment = await prisma.payment.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true, invoiceId: true },
  });
  if (!payment) return;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.payment.delete({ where: { id: payment.id } });
    // Removing money can move a paid invoice back to outstanding.
    await recalculateInvoice(tx, payment.invoiceId);
  });

  revalidatePath("/invoices");
  revalidatePath("/payments");
  revalidatePath(`/invoices/${payment.invoiceId}`);
}

// ------------------------------------------------------- lifecycle actions ---

export async function setInvoiceCancelled(formData: FormData) {
  const { org } = await requirePermission("invoices:write");

  const id = String(formData.get("id") ?? "");
  const cancel = formData.get("cancel") !== "false";
  if (!id) return;

  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true, viewedAt: true, sentAt: true },
  });
  if (!invoice) return;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.invoice.update({
      where: { id },
      data: cancel
        ? { status: "CANCELLED", cancelledAt: new Date() }
        : {
            status: invoice.sentAt
              ? invoice.viewedAt
                ? "VIEWED"
                : "SENT"
              : "DRAFT",
            cancelledAt: null,
          },
    });

    // Reinstating recomputes whether it is already settled.
    if (!cancel) await recalculateInvoice(tx, id);
  });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${id}`);
}

export async function duplicateInvoice(formData: FormData) {
  const { user, org } = await requirePermission("invoices:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const source = await prisma.invoice.findFirst({
    where: { id, organizationId: org.id },
    include: { lineItems: { orderBy: { sortOrder: "asc" } } },
  });
  if (!source) return;

  const copyId = await prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<string> => {
      const number = await allocateNumber(tx, org.id, "invoice");
      const issueDate = new Date();

      const created: { id: string } = await tx.invoice.create({
        data: {
          organizationId: org.id,
          number,
          title: source.title,
          status: "DRAFT",
          clientId: source.clientId,
          addressId: source.addressId,
          issueDate,
          paymentTermsDays: source.paymentTermsDays,
          dueDate: new Date(
            issueDate.getTime() +
              source.paymentTermsDays * 24 * 60 * 60 * 1000,
          ),
          subtotalCents: source.subtotalCents,
          discountType: source.discountType,
          discountValue: source.discountValue,
          discountCents: source.discountCents,
          taxRateBp: source.taxRateBp,
          taxCents: source.taxCents,
          totalCents: source.totalCents,
          amountPaidCents: 0,
          balanceCents: source.totalCents,
          notes: source.notes,
          terms: source.terms,
          createdById: user.id,
          lineItems: {
            create: source.lineItems.map((item) => ({
              kind: item.kind,
              name: item.name,
              description: item.description,
              quantity: item.quantity,
              unit: item.unit,
              unitPriceCents: item.unitPriceCents,
              taxable: item.taxable,
              totalCents: item.totalCents,
              sortOrder: item.sortOrder,
            })),
          },
        },
        select: { id: true },
      });

      return created.id;
    },
  );

  revalidatePath("/invoices");
  redirect(`/invoices/${copyId}`);
}

export async function deleteInvoice(formData: FormData) {
  const { org } = await requirePermission("invoices:delete");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId: org.id },
    select: { status: true, _count: { select: { payments: true } } },
  });
  if (!invoice) return;

  // Deleting used to be refused outright for anything sent or paid, on the
  // reasoning that it is part of the books. That is the right *default* and it
  // is still what the button says — but it is the customer's ledger, and a
  // business setting up has test invoices to clear. The screen states the
  // consequence; this carries it out.
  //
  // Payments cascade with the invoice, by the schema's own foreign key. That
  // is the loss the warning is about.
  await prisma.invoice.deleteMany({ where: { id, organizationId: org.id } });

  revalidatePath("/invoices");
  redirect("/invoices");
}

/**
 * Deletes several invoices at once.
 *
 * Exists because clearing test data one invoice at a time is six visits and a
 * confirmation each. The rule is the same as the single delete — the caller has
 * been told what it costs — but the counting happens here so the ids can never
 * be trusted from the form: each one is checked against the organization before
 * anything is removed.
 */
export async function deleteInvoices(formData: FormData) {
  const { org } = await requirePermission("invoices:delete");

  const submitted = formData
    .getAll("ids")
    .filter((value): value is string => typeof value === "string" && value !== "");

  if (submitted.length === 0) return;

  // Scoped to this business, so an edited form cannot reach another one's books.
  const { count } = await prisma.invoice.deleteMany({
    where: { id: { in: submitted }, organizationId: org.id },
  });

  if (count === 0) return;

  revalidatePath("/invoices");
  revalidatePath("/payments");
  revalidatePath("/reports");
}

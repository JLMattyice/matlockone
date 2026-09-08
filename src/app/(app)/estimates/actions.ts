"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { DISCOUNT_TYPES, LINE_ITEM_KINDS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { effectiveEstimateStatus } from "@/lib/documents";
import { publicUrl, sendMessage } from "@/lib/messaging";
import { computeTotals, formatMoney } from "@/lib/money";
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

const estimateSchema = z.object({
  clientId: z.string().min(1, "Choose a client."),
  addressId: z.string().trim().nullish(),
  title: z.string().trim().nullish(),
  issueDate: z.string().trim().min(1, "Pick an issue date."),
  expiresAt: z.string().trim().nullish(),
  discountType: z.enum(DISCOUNT_TYPES),
  /** Basis points when PERCENT, cents when FIXED. */
  discountValue: z.coerce.number().int().min(0).max(100_000_000),
  taxRateBp: z.coerce.number().int().min(0).max(10_000),
  notes: z.string().trim().nullish(),
  terms: z.string().trim().nullish(),
  lineItems: z.array(lineItemSchema).min(1, "Add at least one line."),
});

type EstimateInput = z.infer<typeof estimateSchema>;

function parseEstimateForm(formData: FormData) {
  let lineItems: unknown = [];
  const raw = formData.get("lineItemsJson");
  if (typeof raw === "string" && raw.trim()) {
    try {
      lineItems = JSON.parse(raw);
    } catch {
      lineItems = [];
    }
  }

  return estimateSchema.safeParse({
    clientId: formData.get("clientId"),
    addressId: text(formData, "addressId"),
    title: text(formData, "title"),
    issueDate: formData.get("issueDate"),
    expiresAt: text(formData, "expiresAt"),
    discountType: formData.get("discountType") ?? "NONE",
    discountValue: formData.get("discountValue") ?? 0,
    taxRateBp: formData.get("taxRateBp") ?? 0,
    notes: text(formData, "notes"),
    terms: text(formData, "terms"),
    lineItems,
  });
}

/** "YYYY-MM-DD" from a date input, anchored to midday to dodge DST edges. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Totals are always recomputed here from the submitted lines. The editor shows
 * a running total for feedback, but the browser's arithmetic never reaches the
 * database — a tampered payload cannot set its own price.
 */
function totalsFor(input: EstimateInput) {
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

async function resolveClientAndAddress(
  clientId: string,
  addressId: string | null | undefined,
  organizationId: string,
) {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId },
    select: { id: true },
  });
  if (!client) return null;

  if (!addressId) return { clientId: client.id, addressId: null };

  const address = await prisma.address.findFirst({
    where: { id: addressId, organizationId, clientId: client.id },
    select: { id: true },
  });

  return { clientId: client.id, addressId: address?.id ?? null };
}

function lineItemRows(input: EstimateInput, lineTotals: number[]) {
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

// ------------------------------------------------------------------ create ---

export async function createEstimate(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("estimates:write");

  const parsed = parseEstimateForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;

  const resolved = await resolveClientAndAddress(
    input.clientId,
    input.addressId,
    org.id,
  );
  if (!resolved) {
    return { ok: false, fieldErrors: { clientId: "Choose a client." } };
  }

  const issueDate = parseDate(input.issueDate) ?? new Date();
  const totals = totalsFor(input);

  const estimateId = await prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<string> => {
      const number = await allocateNumber(tx, org.id, "estimate");

      const created: { id: string } = await tx.estimate.create({
        data: {
          organizationId: org.id,
          number,
          title: input.title ?? null,
          status: "DRAFT",
          clientId: resolved.clientId,
          addressId: resolved.addressId,
          issueDate,
          expiresAt:
            parseDate(input.expiresAt) ??
            new Date(
              issueDate.getTime() +
                org.defaultEstimateValidDays * 24 * 60 * 60 * 1000,
            ),
          subtotalCents: totals.subtotalCents,
          discountType: input.discountType,
          discountValue: input.discountValue,
          discountCents: totals.discountCents,
          taxRateBp: input.taxRateBp,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
          notes: input.notes ?? null,
          terms: input.terms ?? org.estimateFooter,
          createdById: user.id,
          lineItems: { create: lineItemRows(input, totals.lineTotalsCents) },
        },
        select: { id: true },
      });

      return created.id;
    },
  );

  revalidatePath("/estimates");
  redirect(`/estimates/${estimateId}`);
}

export async function updateEstimate(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("estimates:write");

  const id = text(formData, "id");
  if (!id) return failed("Missing estimate id.");

  const existing = await prisma.estimate.findFirst({
    where: { id, organizationId: org.id },
    select: { status: true, expiresAt: true },
  });
  if (!existing) return failed("That estimate no longer exists.");

  // Once a client has accepted or declined, the document is a record of what
  // they responded to. Editing it would rewrite that after the fact.
  const status = effectiveEstimateStatus(existing);
  if (status === "ACCEPTED" || status === "DECLINED") {
    return failed(
      `This estimate has been ${status.toLowerCase()} and can no longer be edited. Duplicate it to make a revised version.`,
    );
  }

  const parsed = parseEstimateForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;

  const resolved = await resolveClientAndAddress(
    input.clientId,
    input.addressId,
    org.id,
  );
  if (!resolved) {
    return { ok: false, fieldErrors: { clientId: "Choose a client." } };
  }

  const totals = totalsFor(input);

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.estimate.update({
      where: { id },
      data: {
        title: input.title ?? null,
        clientId: resolved.clientId,
        addressId: resolved.addressId,
        issueDate: parseDate(input.issueDate) ?? new Date(),
        expiresAt: parseDate(input.expiresAt),
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

    // Nothing references an individual line, so replacing the set wholesale is
    // simpler and cheaper than diffing it.
    await tx.estimateLineItem.deleteMany({ where: { estimateId: id } });
    await tx.estimateLineItem.createMany({
      data: lineItemRows(input, totals.lineTotalsCents).map((row) => ({
        ...row,
        estimateId: id,
      })),
    });
  });

  revalidatePath("/estimates");
  revalidatePath(`/estimates/${id}`);
  return saved("Estimate updated.");
}

// -------------------------------------------------------------------- send ---

export async function sendEstimate(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("estimates:send");

  const id = String(formData.get("id") ?? "");
  if (!id) return failed("Missing estimate id.");

  const estimate = await prisma.estimate.findFirst({
    where: { id, organizationId: org.id },
    include: {
      client: { select: { displayName: true, email: true } },
      _count: { select: { lineItems: true } },
    },
  });
  if (!estimate) return failed("That estimate no longer exists.");

  if (estimate._count.lineItems === 0) {
    return failed("Add at least one line before sending.");
  }

  const to = text(formData, "email") ?? estimate.client.email;
  if (!to) {
    return {
      ok: false,
      fieldErrors: {
        email: "This client has no email address. Add one, or enter one here.",
      },
    };
  }

  const link = publicUrl(`/share/estimate/${estimate.publicToken}`);
  const amount = formatMoney(estimate.totalCents, org.currency, org.locale);

  const result = await sendMessage({
    organizationId: org.id,
    channel: "EMAIL",
    to,
    toName: estimate.client.displayName,
    subject: `Estimate ${estimate.number} from ${org.name}`,
    body: [
      `Hi ${estimate.client.displayName},`,
      "",
      `Your estimate ${estimate.number} for ${amount} is ready to review.`,
      "",
      `View and respond: ${link}`,
      "",
      estimate.expiresAt
        ? `This estimate is valid until ${estimate.expiresAt.toDateString()}.`
        : "",
      "",
      `Thank you,`,
      org.name,
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
    relatedType: "estimate",
    relatedId: estimate.id,
    createdById: user.id,
  });

  if (!result.ok) {
    return failed(result.error ?? "Could not send that estimate.");
  }

  await prisma.estimate.update({
    where: { id },
    data: {
      // Re-sending an already-viewed estimate must not reset it to Sent.
      status: estimate.status === "DRAFT" ? "SENT" : estimate.status,
      sentAt: estimate.sentAt ?? new Date(),
      expiresAt:
        estimate.expiresAt ??
        new Date(
          Date.now() + org.defaultEstimateValidDays * 24 * 60 * 60 * 1000,
        ),
    },
  });

  revalidatePath("/estimates");
  revalidatePath(`/estimates/${id}`);

  return result.delivered
    ? saved(`Sent to ${to}.`)
    : saved(
        `Marked as sent and saved to the outbox. Connect an email account under Settings → Email to deliver it to ${to}.`,
      );
}

// ------------------------------------------------------------------ status ---

/** Records a response the client gave over the phone or in person. */
export async function setEstimateResponse(formData: FormData) {
  const { org } = await requirePermission("estimates:write");

  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!id) return;

  const estimate = await prisma.estimate.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true },
  });
  if (!estimate) return;

  const now = new Date();
  const data: Prisma.EstimateUpdateInput =
    decision === "ACCEPTED"
      ? { status: "ACCEPTED", acceptedAt: now, declinedAt: null, declineReason: null }
      : decision === "DECLINED"
        ? {
            status: "DECLINED",
            declinedAt: now,
            acceptedAt: null,
            declineReason: text(formData, "declineReason") ?? null,
          }
        : { status: "SENT", acceptedAt: null, declinedAt: null, declineReason: null };

  await prisma.estimate.update({ where: { id }, data });

  revalidatePath("/estimates");
  revalidatePath(`/estimates/${id}`);
}

// ----------------------------------------------------------------- convert ---

/**
 * Turns an accepted estimate into a scheduled job.
 *
 * The estimate is kept and linked rather than consumed, so the quote the client
 * agreed to stays readable next to the work. Running it twice is a no-op that
 * lands on the job already created.
 */
export async function convertEstimateToJob(formData: FormData) {
  const { user, org } = await requirePermission("estimates:write");
  await requirePermission("jobs:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const estimate = await prisma.estimate.findFirst({
    where: { id, organizationId: org.id },
    include: { lineItems: { orderBy: { sortOrder: "asc" } } },
  });
  if (!estimate) return;

  if (estimate.convertedJobId) redirect(`/jobs/${estimate.convertedJobId}`);

  const scheduledStartRaw = text(formData, "scheduledStart");
  const scheduledStart = scheduledStartRaw ? new Date(scheduledStartRaw) : null;
  const validStart =
    scheduledStart && !Number.isNaN(scheduledStart.getTime())
      ? scheduledStart
      : null;

  const minutes = Number(formData.get("durationMinutes")) || 120;

  const jobId = await prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<string> => {
      const number = await allocateNumber(tx, org.id, "job");

      const created: { id: string } = await tx.job.create({
        data: {
          organizationId: org.id,
          number,
          kind: "JOB",
          title:
            estimate.title ??
            estimate.lineItems[0]?.name ??
            `Work from ${estimate.number}`,
          description: estimate.notes,
          clientId: estimate.clientId,
          addressId: estimate.addressId,
          status: "SCHEDULED",
          priority: "NORMAL",
          scheduledStart: validStart,
          scheduledEnd: validStart
            ? new Date(validStart.getTime() + minutes * 60_000)
            : null,
          estimatedMinutes: minutes,
          createdById: user.id,
        },
        select: { id: true },
      });

      await tx.estimate.update({
        where: { id: estimate.id },
        data: {
          convertedJobId: created.id,
          status: "ACCEPTED",
          acceptedAt: estimate.acceptedAt ?? new Date(),
        },
      });

      return created.id;
    },
  );

  revalidatePath("/estimates");
  revalidatePath("/jobs");
  revalidatePath("/schedule");
  redirect(`/jobs/${jobId}`);
}

// --------------------------------------------------------------- duplicate ---

export async function duplicateEstimate(formData: FormData) {
  const { user, org } = await requirePermission("estimates:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const source = await prisma.estimate.findFirst({
    where: { id, organizationId: org.id },
    include: { lineItems: { orderBy: { sortOrder: "asc" } } },
  });
  if (!source) return;

  const copyId = await prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<string> => {
      const number = await allocateNumber(tx, org.id, "estimate");
      const issueDate = new Date();

      const created: { id: string } = await tx.estimate.create({
        data: {
          organizationId: org.id,
          number,
          title: source.title,
          status: "DRAFT",
          clientId: source.clientId,
          addressId: source.addressId,
          issueDate,
          expiresAt: new Date(
            issueDate.getTime() +
              org.defaultEstimateValidDays * 24 * 60 * 60 * 1000,
          ),
          subtotalCents: source.subtotalCents,
          discountType: source.discountType,
          discountValue: source.discountValue,
          discountCents: source.discountCents,
          taxRateBp: source.taxRateBp,
          taxCents: source.taxCents,
          totalCents: source.totalCents,
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

  revalidatePath("/estimates");
  redirect(`/estimates/${copyId}`);
}

// ------------------------------------------------------------------ delete ---

export async function deleteEstimate(formData: FormData) {
  const { org } = await requirePermission("estimates:delete");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const estimate = await prisma.estimate.findFirst({
    where: { id, organizationId: org.id },
    select: {
      convertedJobId: true,
      _count: { select: { invoices: true } },
    },
  });
  if (!estimate) return;

  // Converted or invoiced estimates are the paper trail behind work that
  // exists; removing one would leave the job or invoice pointing at nothing.
  if (estimate.convertedJobId || estimate._count.invoices > 0) return;

  await prisma.estimate.deleteMany({ where: { id, organizationId: org.id } });

  revalidatePath("/estimates");
  redirect("/estimates");
}

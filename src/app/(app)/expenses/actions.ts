"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { bool, failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { EXPENSE_CATEGORIES, PAYMENT_METHODS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { parseMoneyToCents } from "@/lib/money";

const expenseSchema = z
  .object({
    description: z.string().trim().min(1, "Describe what this was for."),
    category: z.enum(EXPENSE_CATEGORIES),
    vendor: z.string().trim().nullish(),
    amount: z.string().trim().min(1, "Enter an amount."),
    tax: z.string().trim().nullish(),
    method: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().nullish(),
    spentAt: z.string().trim().min(1, "Pick a date."),
    jobId: z.string().trim().nullish(),
    clientId: z.string().trim().nullish(),
    billable: z.boolean(),
    reimbursable: z.boolean(),
    paidById: z.string().trim().nullish(),
  })
  .superRefine((input, ctx) => {
    const amountCents = parseMoneyToCents(input.amount);
    if (amountCents == null || amountCents <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: "Enter an amount greater than zero.",
      });
      return;
    }

    // Tax is the recoverable slice of the receipt total, not an addition to it.
    const taxCents = parseMoneyToCents(input.tax ?? null) ?? 0;
    if (taxCents < 0) {
      ctx.addIssue({ code: "custom", path: ["tax"], message: "Tax cannot be negative." });
    } else if (taxCents > amountCents) {
      ctx.addIssue({
        code: "custom",
        path: ["tax"],
        message: "Tax is part of the total, so it cannot exceed it.",
      });
    }

    if (Number.isNaN(Date.parse(input.spentAt))) {
      ctx.addIssue({ code: "custom", path: ["spentAt"], message: "Pick a valid date." });
    }
  });

function parseExpenseForm(formData: FormData) {
  return expenseSchema.safeParse({
    description: formData.get("description"),
    category: formData.get("category") ?? "OTHER",
    vendor: text(formData, "vendor"),
    amount: formData.get("amount") ?? "",
    tax: text(formData, "tax"),
    method: formData.get("method") ?? "CARD",
    reference: text(formData, "reference"),
    spentAt: formData.get("spentAt") ?? "",
    jobId: text(formData, "jobId"),
    clientId: text(formData, "clientId"),
    billable: bool(formData, "billable"),
    reimbursable: bool(formData, "reimbursable"),
    paidById: text(formData, "paidById"),
  });
}

/**
 * A date input gives a bare "2026-09-07", which `new Date` reads as UTC
 * midnight and can render as the previous day west of Greenwich. Building it
 * from the parts keeps the day the user picked.
 */
function parseSpentAt(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date(value);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

type Links = { jobId: string | null; clientId: string | null; paidById: string | null };

/**
 * Every foreign key an expense carries has to belong to the caller's own
 * organization — the ids arrive from a form and are not to be trusted.
 *
 * A job already knows whose work it is, so booking an expense to a job takes
 * that job's client rather than whatever the client field happened to hold.
 * One cost cannot belong to one client and a different client's job.
 */
async function resolveLinks(
  input: {
    jobId?: string | null;
    clientId?: string | null;
    paidById?: string | null;
  },
  organizationId: string,
): Promise<Links> {
  const [job, client, payer] = await Promise.all([
    input.jobId
      ? prisma.job.findFirst({
          where: { id: input.jobId, organizationId },
          select: { id: true, clientId: true },
        })
      : null,
    input.clientId
      ? prisma.client.findFirst({
          where: { id: input.clientId, organizationId },
          select: { id: true },
        })
      : null,
    input.paidById
      ? prisma.user.findFirst({
          where: { id: input.paidById, organizationId, isActive: true },
          select: { id: true },
        })
      : null,
  ]);

  return {
    jobId: job?.id ?? null,
    clientId: job ? job.clientId : (client?.id ?? null),
    paidById: payer?.id ?? null,
  };
}

export async function createExpense(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("expenses:write");

  const parsed = parseExpenseForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const links = await resolveLinks(input, org.id);

  const expense = await prisma.expense.create({
    data: {
      organizationId: org.id,
      description: input.description,
      category: input.category,
      vendor: input.vendor ?? null,
      amountCents: parseMoneyToCents(input.amount)!,
      taxCents: parseMoneyToCents(input.tax ?? null) ?? 0,
      method: input.method,
      reference: input.reference ?? null,
      spentAt: parseSpentAt(input.spentAt),
      billable: input.billable,
      reimbursable: input.reimbursable,
      createdById: user.id,
      ...links,
    },
  });

  revalidatePath("/expenses");
  redirect(`/expenses/${expense.id}`);
}

export async function updateExpense(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("expenses:write");

  const id = text(formData, "id");
  if (!id) return failed("Missing expense id.");

  const existing = await prisma.expense.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true },
  });
  if (!existing) return failed("That expense no longer exists.");

  const parsed = parseExpenseForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const links = await resolveLinks(input, org.id);

  await prisma.expense.update({
    where: { id },
    data: {
      description: input.description,
      category: input.category,
      vendor: input.vendor ?? null,
      amountCents: parseMoneyToCents(input.amount)!,
      taxCents: parseMoneyToCents(input.tax ?? null) ?? 0,
      method: input.method,
      reference: input.reference ?? null,
      spentAt: parseSpentAt(input.spentAt),
      billable: input.billable,
      reimbursable: input.reimbursable,
      // Clearing the reimbursable flag has to clear the settlement with it,
      // or the record claims a repayment that no longer applies.
      ...(input.reimbursable ? {} : { reimbursedAt: null }),
      ...links,
    },
  });

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${id}`);
  return saved("Expense updated.");
}

/** Marks money owed to a teammate as paid back, or undoes that. */
export async function toggleExpenseReimbursed(formData: FormData) {
  const { org } = await requirePermission("expenses:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const expense = await prisma.expense.findFirst({
    where: { id, organizationId: org.id },
    select: { reimbursable: true, reimbursedAt: true },
  });
  if (!expense || !expense.reimbursable) return;

  await prisma.expense.update({
    where: { id },
    data: { reimbursedAt: expense.reimbursedAt ? null : new Date() },
  });

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${id}`);
}

export async function toggleExpenseBillable(formData: FormData) {
  const { org } = await requirePermission("expenses:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const expense = await prisma.expense.findFirst({
    where: { id, organizationId: org.id },
    select: { billable: true },
  });
  if (!expense) return;

  await prisma.expense.update({
    where: { id },
    data: { billable: !expense.billable },
  });

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${id}`);
}

export async function deleteExpense(formData: FormData) {
  const { org } = await requirePermission("expenses:delete");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await prisma.expense.deleteMany({ where: { id, organizationId: org.id } });

  revalidatePath("/expenses");
  redirect("/expenses");
}

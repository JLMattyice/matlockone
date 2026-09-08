import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowLeft, Check, Pencil, Undo2 } from "lucide-react";

import {
  deleteExpense,
  toggleExpenseBillable,
  toggleExpenseReimbursed,
} from "../actions";
import { getExpense } from "../queries";
import { AttachmentPanel } from "@/components/files/attachment-panel";
import { NotesPanel } from "@/components/notes/notes-panel";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { getContext, requirePermission } from "@/lib/auth";
import {
  asStatus,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type ExpenseCategory,
  type PaymentMethod,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/permissions";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const ctx = await getContext();
  if (!ctx) return { title: "Expense" };

  const { id } = await params;
  const expense = await prisma.expense.findFirst({
    where: { id, organizationId: ctx.org.id },
    select: { description: true },
  });

  return { title: expense?.description ?? "Expense" };
}

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, org } = await requirePermission("expenses:read");
  const { id } = await params;
  const expense = await getExpense(org.id, id);

  const writable = can(user, "expenses:write");
  const deletable = can(user, "expenses:delete");
  const canAttach = can(user, "files:write");

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const category = asStatus(
    EXPENSE_CATEGORIES,
    expense.category,
    "OTHER",
  ) as ExpenseCategory;
  const method = asStatus(
    PAYMENT_METHODS,
    expense.method,
    "OTHER",
  ) as PaymentMethod;

  const owedBack = expense.reimbursable && !expense.reimbursedAt;

  return (
    <div className="space-y-6">
      <Link
        href="/expenses"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        Expenses
      </Link>

      {/* -------------------------------------------------------- header --- */}
      <Card>
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-ink">
                {expense.description}
              </h1>
              <Badge tone="neutral">{EXPENSE_CATEGORY_LABELS[category]}</Badge>
              {expense.billable ? <Badge tone="accent">Rebillable</Badge> : null}
              {owedBack ? <Badge tone="warning">Owed back</Badge> : null}
              {expense.reimbursedAt ? (
                <Badge tone="success" dot>
                  Reimbursed
                </Badge>
              ) : null}
            </div>

            <p className="mt-1 text-sm text-ink-muted">
              {expense.vendor ? `${expense.vendor} · ` : ""}
              {format(expense.spentAt, "EEEE, MMMM d, yyyy")}
            </p>
          </div>

          <div className="shrink-0 text-left sm:text-right">
            <p className="tabular text-2xl font-semibold text-ink">
              {money(expense.amountCents)}
            </p>
            {expense.taxCents > 0 ? (
              <p className="tabular mt-0.5 text-xs text-ink-subtle">
                includes {money(expense.taxCents)} tax
              </p>
            ) : null}
          </div>
        </div>

        {writable || deletable ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
            {writable ? (
              <>
                <Link
                  href={`/expenses/${expense.id}/edit`}
                  className={buttonClasses("outline", "sm")}
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                  Edit
                </Link>

                <form action={toggleExpenseBillable}>
                  <input type="hidden" name="id" value={expense.id} />
                  <button type="submit" className={buttonClasses("ghost", "sm")}>
                    {expense.billable ? "Not rebillable" : "Mark rebillable"}
                  </button>
                </form>

                {expense.reimbursable ? (
                  <form action={toggleExpenseReimbursed}>
                    <input type="hidden" name="id" value={expense.id} />
                    <button
                      type="submit"
                      className={buttonClasses(
                        expense.reimbursedAt ? "ghost" : "outline",
                        "sm",
                      )}
                    >
                      {expense.reimbursedAt ? (
                        <>
                          <Undo2 className="h-3.5 w-3.5" strokeWidth={2} />
                          Undo reimbursement
                        </>
                      ) : (
                        <>
                          <Check className="h-3.5 w-3.5" strokeWidth={2} />
                          Mark reimbursed
                        </>
                      )}
                    </button>
                  </form>
                ) : null}
              </>
            ) : null}

            {deletable ? (
              <form action={deleteExpense} className="ml-auto">
                <input type="hidden" name="id" value={expense.id} />
                <ConfirmButton variant="ghost" size="sm" confirmLabel="Delete?">
                  Delete
                </ConfirmButton>
              </form>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* ----------------------------------------------------------- body --- */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="overflow-hidden">
            <CardHeader
              title="Receipt"
              description="Attach the receipt while you still have it."
            />
            <AttachmentPanel
              attachments={expense.attachments}
              entityType="expense"
              entityId={expense.id}
              canWrite={canAttach}
            />
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Notes" />
            <NotesPanel
              notes={expense.notes}
              entityType="expense"
              entityId={expense.id}
              canWrite={writable}
              placeholder="Anything worth remembering about this cost?"
              emptyDescription="Why it was bought, or what it was swapped for."
            />
          </Card>
        </div>

        <Card>
          <CardHeader title="Details" />
          <dl className="divide-y divide-line text-sm">
            <Detail label="Category">{EXPENSE_CATEGORY_LABELS[category]}</Detail>
            <Detail label="Vendor">{expense.vendor ?? "Not recorded"}</Detail>
            <Detail label="Paid with">{PAYMENT_METHOD_LABELS[method]}</Detail>
            <Detail label="Reference">{expense.reference ?? "—"}</Detail>
            <Detail label="Paid by">
              {expense.paidBy?.name ?? "The business"}
            </Detail>

            <Detail label={org.labelJobSingular}>
              {expense.job ? (
                <Link
                  href={`/jobs/${expense.job.id}`}
                  className="text-brand hover:underline"
                >
                  {expense.job.number}
                </Link>
              ) : (
                "Overhead"
              )}
            </Detail>

            <Detail label={org.labelClientSingular}>
              {expense.client ? (
                <Link
                  href={`/clients/${expense.client.id}`}
                  className="text-brand hover:underline"
                >
                  {expense.client.displayName}
                </Link>
              ) : (
                "—"
              )}
            </Detail>

            {expense.reimbursedAt ? (
              <Detail label="Reimbursed">
                {format(expense.reimbursedAt, "MMM d, yyyy")}
              </Detail>
            ) : null}

            <Detail label="Recorded">
              {format(expense.createdAt, "MMM d, yyyy")}
              {expense.createdBy ? ` by ${expense.createdBy.name}` : ""}
            </Detail>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-4 px-5 py-2.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{children}</dd>
    </div>
  );
}

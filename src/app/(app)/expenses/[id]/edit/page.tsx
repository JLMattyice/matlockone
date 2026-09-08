import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowLeft } from "lucide-react";

import { ExpenseForm } from "../../expense-form";
import {
  clientOptions,
  getExpense,
  jobOptions,
  payerOptions,
} from "../../queries";
import { requirePermission } from "@/lib/auth";
import {
  asStatus,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  type ExpenseCategory,
} from "@/lib/constants";
import { centsToInput, currencySymbol } from "@/lib/money";

export const metadata: Metadata = { title: "Edit expense" };

export default async function EditExpensePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { org } = await requirePermission("expenses:write");
  const { id } = await params;

  const [expense, jobs, clients, payers] = await Promise.all([
    getExpense(org.id, id),
    jobOptions(org.id),
    clientOptions(org.id),
    payerOptions(org.id),
  ]);

  // The bounded pickers only carry recent records; an expense already booked
  // to an older one has to keep it rather than silently losing the link.
  const jobChoices = expense.job && !jobs.some((job) => job.id === expense.job!.id)
    ? [{ ...expense.job, client: expense.client }, ...jobs]
    : jobs;

  const clientChoices =
    expense.client && !clients.some((client) => client.id === expense.client!.id)
      ? [expense.client, ...clients]
      : clients;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={`/expenses/${expense.id}`}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          {expense.description}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Edit expense
        </h1>
      </div>

      <ExpenseForm
        jobs={jobChoices}
        clients={clientChoices}
        payers={payers}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        jobLabel={org.labelJobSingular}
        clientLabel={org.labelClientSingular}
        values={{
          id: expense.id,
          description: expense.description,
          category: asStatus(
            EXPENSE_CATEGORIES,
            expense.category,
            "OTHER",
          ) as ExpenseCategory,
          vendor: expense.vendor ?? "",
          amount: centsToInput(expense.amountCents),
          tax: expense.taxCents ? centsToInput(expense.taxCents) : "",
          method: asStatus(PAYMENT_METHODS, expense.method, "OTHER"),
          reference: expense.reference ?? "",
          spentAt: format(expense.spentAt, "yyyy-MM-dd"),
          jobId: expense.jobId ?? "",
          clientId: expense.clientId ?? "",
          billable: expense.billable,
          reimbursable: expense.reimbursable,
          paidById: expense.paidById ?? "",
        }}
      />
    </div>
  );
}

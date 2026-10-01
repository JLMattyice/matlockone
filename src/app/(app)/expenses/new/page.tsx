import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { ExpenseForm, type ExpenseFormValues } from "../expense-form";
import { clientOptions, jobOptions, payerOptions } from "../queries";
import { requirePermission } from "@/lib/auth";
import { asStatus, EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/constants";
import { currencySymbol, formatMoney } from "@/lib/money";
import { latestExpenseIn } from "@/lib/recurring-expenses";
import { todayIn } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "Record expense" };

export default async function NewExpensePage({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string; clientId?: string; repeat?: string; date?: string }>;
}) {
  const { user, org } = await requirePermission("expenses:write");
  const params = await searchParams;
  const zone = await viewerTimeZone();

  const [jobs, clients, payers] = await Promise.all([
    jobOptions(org.id),
    clientOptions(org.id),
    payerOptions(org.id),
  ]);

  // Arriving from a job or client page pre-books the expense against it.
  const jobId = jobs.some((job) => job.id === params.jobId) ? params.jobId! : "";
  const clientId =
    !jobId && clients.some((client) => client.id === params.clientId)
      ? params.clientId!
      : "";

  // Arriving from "Time to enter the electric bill": everything but the
  // amount comes from last time, and saving it joins the series.
  const previous = params.repeat ? await latestExpenseIn(params.repeat, org.id) : null;
  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const spentAt =
    previous && params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
      ? params.date
      : todayIn(zone);

  const values: ExpenseFormValues = previous
    ? {
        description: previous.description,
        category: asStatus(EXPENSE_CATEGORIES, previous.category, "OTHER") as ExpenseCategory,
        vendor: previous.vendor ?? "",
        amount: "",
        tax: "",
        method: previous.method,
        reference: "",
        spentAt,
        jobId: previous.jobId ?? "",
        clientId: previous.clientId ?? "",
        billable: previous.billable,
        reimbursable: previous.reimbursable,
        paidById: previous.paidById ?? "",
        scheduleId: previous.scheduleId ?? undefined,
      }
    : {
        description: "",
        category: "MATERIALS",
        vendor: "",
        amount: "",
        tax: "",
        method: "CARD",
        reference: "",
        spentAt,
        jobId,
        clientId,
        billable: false,
        reimbursable: false,
        // Whoever is recording it is usually the one who paid.
        paidById: user.id,
      };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/expenses"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Expenses
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          {previous ? `Enter ${previous.description}` : "Record expense"}
        </h1>
        {previous ? (
          <p className="mt-1 text-sm text-ink-muted">
            A repeating bill. Everything is filled in from last time except the amount.
          </p>
        ) : null}
      </div>

      <ExpenseForm
        jobs={jobs}
        clients={clients}
        payers={payers}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        jobLabel={org.labelJobSingular}
        clientLabel={org.labelClientSingular}
        amountHint={previous ? `Last time: ${money(previous.amountCents)}.` : undefined}
        values={values}
      />
    </div>
  );
}

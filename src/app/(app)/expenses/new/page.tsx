import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowLeft } from "lucide-react";

import { ExpenseForm } from "../expense-form";
import { clientOptions, jobOptions, payerOptions } from "../queries";
import { requirePermission } from "@/lib/auth";
import { currencySymbol } from "@/lib/money";

export const metadata: Metadata = { title: "Record expense" };

export default async function NewExpensePage({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string; clientId?: string }>;
}) {
  const { user, org } = await requirePermission("expenses:write");
  const params = await searchParams;

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
          Record expense
        </h1>
      </div>

      <ExpenseForm
        jobs={jobs}
        clients={clients}
        payers={payers}
        currencySymbol={currencySymbol(org.currency, org.locale)}
        jobLabel={org.labelJobSingular}
        clientLabel={org.labelClientSingular}
        values={{
          description: "",
          category: "MATERIALS",
          vendor: "",
          amount: "",
          tax: "",
          method: "CARD",
          reference: "",
          spentAt: format(new Date(), "yyyy-MM-dd"),
          jobId,
          clientId,
          billable: false,
          reimbursable: false,
          // Whoever is recording it is usually the one who paid.
          paidById: user.id,
        }}
      />
    </div>
  );
}
